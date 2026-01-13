/**
 * Z.AI OpenAI Proxy Worker
 * 
 * This worker proxies OpenAI-compatible API requests to Z.AI,
 * allowing standard OpenAI SDK clients to use Z.AI models seamlessly.
 * 
 * Features:
 * - Proxies all OpenAI API endpoints to Z.AI
 * - Uses ZAI_API_KEY from environment secrets
 * - Sets GLM 4.7 as the default model
 * - Supports streaming responses
 */

interface Env {
	ZAI_API_KEY: string;
}

const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const DEFAULT_MODEL = 'glm-4.7';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return handleCORS();
		}

		// Health check endpoint
		const url = new URL(request.url);
		if (url.pathname === '/' || url.pathname === '/health') {
			return new Response(JSON.stringify({
				status: 'ok',
				service: 'Z.AI OpenAI Proxy',
				default_model: DEFAULT_MODEL,
				rate_limit_info: '~120 prompts per 5 hours (Lite Coding Plan)'
			}), {
				headers: { 'Content-Type': 'application/json', ...corsHeaders() }
			});
		}

		// Legacy completions endpoint (for TaskMaster MCP compatibility)
		if (url.pathname === '/v1/completions') {
			return handleLegacyCompletions(request, env, ctx);
		}

		// Models endpoint
		if (url.pathname === '/v1/models' || url.pathname === '/models') {
			return handleModelsEndpoint();
		}

		// Check for API key
		if (!env.ZAI_API_KEY) {
			return new Response(JSON.stringify({
				error: {
					message: 'ZAI_API_KEY secret is not configured',
					type: 'configuration_error'
				}
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders() }
			});
		}

		// Proxy the request to Z.AI
		try {
			return await proxyRequest(request, env, url);
		} catch (error) {
			console.error('Proxy error:', error);
			return new Response(JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : 'Internal proxy error',
					type: 'proxy_error'
				}
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders() }
			});
		}
	},
} satisfies ExportedHandler<Env>;

async function handleLegacyCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	console.log('[DEBUG] Legacy completions request received');
	
	try {
		const body = await request.json() as Record<string, unknown>;
		console.log('[DEBUG] Request body:', JSON.stringify(body));

		const chatRequestBody = {
			model: body.model || DEFAULT_MODEL,
			messages: [
				{ role: 'user', content: body.prompt }
			],
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			top_p: body.top_p,
			frequency_penalty: body.frequency_penalty,
			presence_penalty: body.presence_penalty
		};

		Object.keys(chatRequestBody).forEach(key => {
			if (chatRequestBody[key as keyof typeof chatRequestBody] === undefined) {
				delete chatRequestBody[key as keyof typeof chatRequestBody];
			}
		});

		console.log('[DEBUG] Converted to chat format:', JSON.stringify(chatRequestBody));
		console.log('[DEBUG] Calling ZAI API at:', `${ZAI_BASE_URL}/chat/completions`);

		const zaiResponse = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.ZAI_API_KEY}`
			},
			body: JSON.stringify(chatRequestBody)
		});

		console.log('[DEBUG] ZAI response status:', zaiResponse.status);
		console.log('[DEBUG] ZAI response headers:', Object.fromEntries(zaiResponse.headers.entries()));

		if (!zaiResponse.ok) {
			const errorText = await zaiResponse.text();
			console.error('[ERROR] ZAI API error:', zaiResponse.status, errorText);
			return new Response(
				JSON.stringify({
					error: {
						message: `ZAI API error: ${zaiResponse.status} ${errorText}`,
						type: 'api_error',
						param: null,
						code: zaiResponse.status
					}
				}),
				{
					status: zaiResponse.status,
					headers: { 'Content-Type': 'application/json', ...corsHeaders() }
				}
			);
		}

		const zaiData = await zaiResponse.json() as Record<string, unknown>;
		console.log('[DEBUG] ZAI response data:', JSON.stringify(zaiData));

		if (!zaiData.choices || !Array.isArray(zaiData.choices)) {
			console.error('[ERROR] Invalid ZAI response - missing or invalid choices:', zaiData);
			throw new Error('Invalid response from ZAI API');
		}

		const legacyResponse = {
			id: (zaiData.id as string) || `cmpl-${Date.now()}`,
			object: 'text_completion',
			created: (zaiData.created as number) || Math.floor(Date.now() / 1000),
			model: (zaiData.model as string) || (body.model as string) || DEFAULT_MODEL,
			choices: (zaiData.choices as Array<Record<string, unknown>>).map(choice => ({
				index: choice.index as number,
				text: ((choice.message as Record<string, unknown>)?.content as string) || (choice.text as string) || '',
				finish_reason: choice.finish_reason as string
			})),
			usage: zaiData.usage as Record<string, unknown>
		};

		console.log('[DEBUG] Legacy response:', JSON.stringify(legacyResponse));

		return new Response(JSON.stringify(legacyResponse), {
			status: zaiResponse.status,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders()
			}
		});

	} catch (error) {
		console.error('[ERROR] Legacy completions error:', error);
		console.error('[ERROR] Error stack:', error instanceof Error ? error.stack : 'No stack available');
		return new Response(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : 'Internal server error',
					type: 'internal_error',
					param: null,
					code: 'internal_error'
				}
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders() }
			}
		);
	}
}

async function proxyRequest(request: Request, env: Env, url: URL): Promise<Response> {
	// Build the Z.AI URL
	let path = url.pathname;

	// Remove /v1 prefix if present (Z.AI API already includes v4 in base)
	if (path.startsWith('/v1')) {
		path = path.slice(3);
	}

	const zaiUrl = `${ZAI_BASE_URL}${path}${url.search}`;

	// Clone and modify the request body if it's a chat completion
	let body: BodyInit | null = null;
	if (request.method === 'POST' && path.includes('/chat/completions')) {
		const originalBody = await request.json() as Record<string, unknown>;

		// Set default model if not specified
		if (!originalBody.model) {
			originalBody.model = DEFAULT_MODEL;
		}

		body = JSON.stringify(originalBody);
	} else if (request.body) {
		body = request.body;
	}

	// Prepare headers for Z.AI
	const headers = new Headers();
	headers.set('Authorization', `Bearer ${env.ZAI_API_KEY}`);
	headers.set('Content-Type', 'application/json');

	// Copy accept header for streaming
	const accept = request.headers.get('Accept');
	if (accept) {
		headers.set('Accept', accept);
	}

	// Make the request to Z.AI
	const response = await fetch(zaiUrl, {
		method: request.method,
		headers,
		body: request.method !== 'GET' && request.method !== 'HEAD' ? body : undefined,
	});

	// Return the response with CORS headers
	const responseHeaders = new Headers(response.headers);
	Object.entries(corsHeaders()).forEach(([key, value]) => {
		responseHeaders.set(key, value);
	});

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}

function handleModelsEndpoint(): Response {
	const models = {
		object: 'list',
		data: [
			{
				id: 'glm-4.7',
				object: 'model',
				created: 1734825600, // Dec 22, 2025
				owned_by: 'zhipu',
				permission: [],
				root: 'glm-4.7',
				parent: null,
			},
			{
				id: 'glm-4.6',
				object: 'model',
				created: 1730000000,
				owned_by: 'zhipu',
				permission: [],
				root: 'glm-4.6',
				parent: null,
			},
			{
				id: 'glm-4.5',
				object: 'model',
				created: 1725000000,
				owned_by: 'zhipu',
				permission: [],
				root: 'glm-4.5',
				parent: null,
			},
			{
				id: 'glm-4.5-air',
				object: 'model',
				created: 1725000000,
				owned_by: 'zhipu',
				permission: [],
				root: 'glm-4.5-air',
				parent: null,
			},
		],
	};

	return new Response(JSON.stringify(models), {
		headers: { 'Content-Type': 'application/json', ...corsHeaders() }
	});
}

function handleCORS(): Response {
	return new Response(null, {
		status: 204,
		headers: corsHeaders(),
	});
}

function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
		'Access-Control-Max-Age': '86400',
	};
}
