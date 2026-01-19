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

/**
 * Z.AI only supports: system, user, assistant, tool
 * Map unsupported roles to compatible ones
 */
function sanitizeRole(role: string): string {
	const ROLE_MAP: Record<string, string> = {
		'developer': 'system',  // OpenAI's new developer role → system
		'function': 'tool',     // Legacy function role → tool
	};
	const sanitized = ROLE_MAP[role] || role;
	if (sanitized !== role) {
		console.log(`[DEBUG] Role mapped: ${role} → ${sanitized}`);
	}
	return sanitized;
}


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

		// OpenAI Responses API endpoint (for Vercel AI SDK v5)
		// Converts /v1/responses to /chat/completions
		if (url.pathname === '/v1/responses' || url.pathname === '/responses') {
			return handleResponsesAPI(request, env, ctx);
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

/**
 * Handle OpenAI Responses API requests (for Vercel AI SDK v5)
 * Converts Responses API format to Chat Completions format
 */
async function handleResponsesAPI(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	console.log('[DEBUG] Responses API request received');

	try {
		const body = await request.json() as Record<string, unknown>;
		console.log('[DEBUG] Responses API body:', JSON.stringify(body).substring(0, 500));

		// Convert Responses API format to Chat Completions format
		// Responses API uses: input, model, instructions, response_format, tools
		// Chat Completions uses: messages, model, response_format, tools

		const messages: Array<{ role: string, content: string | Array<{ type: string, text?: string }> }> = [];

		// Add system message from instructions if present
		if (body.instructions && typeof body.instructions === 'string') {
			messages.push({ role: 'system', content: body.instructions });
		}

		// Handle input - can be string, array of content items, or array of messages
		if (typeof body.input === 'string') {
			messages.push({ role: 'user', content: body.input });
		} else if (Array.isArray(body.input)) {
			// Input can be an array of content items or messages
			for (const item of body.input) {
				if (typeof item === 'string') {
					messages.push({ role: 'user', content: item });
				} else if (item && typeof item === 'object') {
					const itemObj = item as Record<string, unknown>;

					// Check if this is an OpenAI message format (has 'role' field)
					if (itemObj.role && (itemObj.content !== undefined || itemObj.role === 'assistant')) {
						// Content can be string or array of content parts
						let content: string | Array<{ type: string, text?: string }>;
						if (typeof itemObj.content === 'string') {
							content = itemObj.content;
						} else if (Array.isArray(itemObj.content)) {
							// Handle array of content parts
							content = (itemObj.content as Array<Record<string, unknown>>).map(part => {
								if (typeof part === 'string') {
									return { type: 'text', text: part };
								} else if (part.type === 'text') {
									return { type: 'text', text: part.text as string };
								} else if (part.type === 'input_text') {
									return { type: 'text', text: part.text as string };
								}
								return { type: 'text', text: JSON.stringify(part) };
							});
							// Flatten to string for Z.AI
							content = content.map(c => c.text || '').join('');
						} else {
							content = JSON.stringify(itemObj.content || '');
						}
						messages.push({ role: sanitizeRole(itemObj.role as string), content });
					}
					// Check if this is a content item format (has 'type' field)
					else if (itemObj.type === 'text' && itemObj.text) {
						messages.push({ role: 'user', content: itemObj.text as string });
					} else if (itemObj.type === 'input_text' && itemObj.text) {
						messages.push({ role: 'user', content: itemObj.text as string });
					} else if (itemObj.type === 'message' && itemObj.content) {
						// Handle nested message format
						const role = sanitizeRole(itemObj.role as string || 'user');
						let content: string;
						if (typeof itemObj.content === 'string') {
							content = itemObj.content;
						} else if (Array.isArray(itemObj.content)) {
							content = (itemObj.content as Array<Record<string, unknown>>)
								.filter(c => c.type === 'text' || c.type === 'input_text')
								.map(c => c.text as string)
								.join('');
						} else {
							content = JSON.stringify(itemObj.content);
						}
						messages.push({ role, content });
					}
				}
			}
		}

		// Ensure we have at least one user message
		if (messages.length === 0 || !messages.some(m => m.role === 'user')) {
			// Add a default user message if none exists
			console.log('[DEBUG] No user message found, adding fallback');
			messages.push({ role: 'user', content: 'Please respond.' });
		}

		// Sanitize all roles in final messages array to ensure Z.AI compatibility
		const sanitizedMessages = messages.map(m => ({ ...m, role: sanitizeRole(m.role) }));

		console.log('[DEBUG] Final sanitized messages:', JSON.stringify(sanitizedMessages).substring(0, 500));

		// Build chat completions request
		const chatRequestBody: Record<string, unknown> = {
			model: body.model || DEFAULT_MODEL,
			messages: sanitizedMessages
		};

		// Copy over supported parameters
		if (body.temperature !== undefined) chatRequestBody.temperature = body.temperature;
		if (body.max_tokens !== undefined) chatRequestBody.max_tokens = body.max_tokens;
		if (body.max_output_tokens !== undefined) chatRequestBody.max_tokens = body.max_output_tokens;
		if (body.top_p !== undefined) chatRequestBody.top_p = body.top_p;

		// Handle response_format for structured outputs
		if (body.text && typeof body.text === 'object') {
			const textConfig = body.text as Record<string, unknown>;
			if (textConfig.format && typeof textConfig.format === 'object') {
				chatRequestBody.response_format = textConfig.format;
			}
		}
		if (body.response_format) {
			chatRequestBody.response_format = body.response_format;
		}

		// Handle tools
		if (body.tools && Array.isArray(body.tools)) {
			chatRequestBody.tools = body.tools;
		}
		if (body.tool_choice !== undefined) {
			chatRequestBody.tool_choice = body.tool_choice;
		}

		console.log('[DEBUG] Converted to chat completions:', JSON.stringify(chatRequestBody).substring(0, 500));

		// Make request to Z.AI
		const zaiResponse = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${env.ZAI_API_KEY}`
			},
			body: JSON.stringify(chatRequestBody)
		});

		console.log('[DEBUG] Z.AI response status:', zaiResponse.status);

		if (!zaiResponse.ok) {
			const errorText = await zaiResponse.text();
			console.error('[ERROR] Z.AI API error:', zaiResponse.status, errorText);
			return new Response(errorText, {
				status: zaiResponse.status,
				headers: { 'Content-Type': 'application/json', ...corsHeaders() }
			});
		}

		const zaiData = await zaiResponse.json() as Record<string, unknown>;
		console.log('[DEBUG] Z.AI chat response received');

		// Extract message from Chat Completions response
		const choices = zaiData.choices as Array<Record<string, unknown>> || [];
		const firstChoice = choices[0] || {};
		const message = firstChoice.message as Record<string, unknown> || {};

		// Extract content text from message
		const contentText = (message.content || '') as string;


		// Build Responses API format response
		// SDK v5 expects: id, object, output, output_text (for text/json), usage, status
		const responsesApiResponse: Record<string, unknown> = {
			id: zaiData.id || `resp-${Date.now()}`,
			object: 'response',
			created: zaiData.created || Math.floor(Date.now() / 1000),
			model: zaiData.model || chatRequestBody.model,
			output: [
				{
					type: 'message',
					id: `msg-${Date.now()}`,
					role: 'assistant',
					status: 'completed',
					content: [
						{
							type: 'output_text',  // SDK expects 'output_text' for structured outputs
							text: contentText
						}
					]
				}
			],
			// output_text is the key field SDK v5 uses for generateObject parsing
			output_text: contentText,
			usage: zaiData.usage,
			status: 'completed'
		};


		// Handle tool calls in response
		if (message.tool_calls && Array.isArray(message.tool_calls)) {
			const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
			responsesApiResponse.output = toolCalls.map(tc => ({
				type: 'function_call',
				id: tc.id,
				call_id: tc.id,
				name: (tc.function as Record<string, unknown>)?.name,
				arguments: (tc.function as Record<string, unknown>)?.arguments
			}));
		}

		console.log('[DEBUG] Responses API response:', JSON.stringify(responsesApiResponse).substring(0, 500));

		return new Response(JSON.stringify(responsesApiResponse), {
			status: 200,
			headers: { 'Content-Type': 'application/json', ...corsHeaders() }
		});

	} catch (error) {
		console.error('[ERROR] Responses API error:', error);
		return new Response(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : 'Internal server error',
					type: 'internal_error'
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
