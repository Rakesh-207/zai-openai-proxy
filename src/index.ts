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
