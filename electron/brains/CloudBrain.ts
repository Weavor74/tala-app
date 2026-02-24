
import { IBrain, ChatMessage, BrainResponse, BrainOptions } from './IBrain';
import https from 'https';
import http from 'http';

/**
 * Configuration for a CloudBrain instance.
 * 
 * Specifies the API endpoint, authentication key, and model to use.
 * The endpoint should be an OpenAI-compatible base URL (e.g.,
 * `'https://api.openai.com/v1'` or `'https://openrouter.ai/api/v1'`).
 */
export interface CloudBrainConfig {
    /**
     * Base URL of the API endpoint.
     * 
     * CloudBrain intelligently constructs the full URL:
     * - If it ends with `/chat/completions`, used as-is.
     * - If it ends with `/v1`, appends `/chat/completions`.
     * - Otherwise, appends `/v1/chat/completions`.
     */
    endpoint: string;
    /** Optional API key for authentication (sent as `Bearer` token). */
    apiKey?: string;
    /** Model identifier (e.g., `'gpt-4o'`, `'claude-3-opus'`, `'mistral-large'`). */
    model: string;
}

/**
 * CloudBrain
 * 
 * IBrain implementation for cloud-based LLM inference via OpenAI-compatible
 * REST APIs. Supports any provider that implements the `/v1/chat/completions`
 * endpoint with SSE (Server-Sent Events) streaming.
 * 
 * **Supported providers:**
 * OpenAI, Anthropic (via proxy), OpenRouter, Groq, Gemini, LlamaCPP, vLLM,
 * and any custom OpenAI-compatible server.
 * 
 * **Reasoning model support:**
 * Automatically detects reasoning models (o1, o3, gpt-5) and adjusts the
 * request payload accordingly (uses `max_completion_tokens` instead of
 * `max_tokens`, omits `temperature`).
 * 
 * **Transport:**
 * Uses Node.js `http`/`https` modules directly (not `fetch`) to support
 * fine-grained streaming control and avoid Electron's fetch limitations.
 * 
 * @implements {IBrain}
 */
export class CloudBrain implements IBrain {
    /** Brain identifier, always `'cloud-generic'`. */
    public id: string = 'cloud-generic';
    /** The API configuration (endpoint, key, model). */
    private config: CloudBrainConfig;

    /**
     * Creates a new CloudBrain instance with the given API configuration.
     * 
     * @param {CloudBrainConfig} config - The endpoint, API key, and model to use.
     */
    constructor(config: CloudBrainConfig) {
        this.config = config;
    }

    /**
     * Checks if the cloud API is reachable by sending a GET to `/models`.
     * 
     * Uses the appropriate `http` or `https` module based on the endpoint URL.
     * Sends the API key as a Bearer token for authenticated health checks.
     * 
     * @returns {Promise<boolean>} `true` if the server returns HTTP 200.
     */
    public async ping(): Promise<boolean> {
        return new Promise((resolve) => {
            const url = `${this.config.endpoint}/models`;
            const lib = url.startsWith('https') ? https : http;

            const req = lib.request(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                }
            }, (res) => {
                resolve(res.statusCode === 200);
            });

            req.on('error', () => resolve(false));
            req.end();
        });
    }

    /**
     * Sends a conversation and returns the complete response (non-streaming).
     * 
     * Internally delegates to `streamResponse()` and buffers the result,
     * since the OpenAI API doesn't have a fundamentally different non-streaming
     * mode for `/chat/completions`.
     * 
     * @param {ChatMessage[]} messages - The conversation history.
     * @param {string} [systemPrompt] - Optional system instructions.
     * @returns {Promise<BrainResponse>} The complete buffered response.
     */
    public async generateResponse(messages: ChatMessage[], systemPrompt?: string): Promise<BrainResponse> {
        // Fallback to stream logic but buffer it
        let full = "";
        const res = await this.streamResponse(messages, systemPrompt || "", (chunk) => {
            full += chunk;
        });
        return { ...res, content: full };
    }

    /**
     * Streams a conversation response via SSE (Server-Sent Events).
     * 
     * **URL construction:**
     * Smartly handles various endpoint formats users may paste:
     * - Full path (`/chat/completions`) → used as-is.
     * - Versioned base (`/v1`) → appends `/chat/completions`.
     * - Bare host → appends `/v1/chat/completions`.
     * 
     * **Reasoning model detection:**
     * Models matching `/^(o[13]|gpt-5)/i` are treated as reasoning models:
     * - Uses `max_completion_tokens` instead of `max_tokens`.
     * - Omits `temperature` (rejected by these models).
     * 
     * **SSE parsing:**
     * Reads `data: {json}` lines from the response stream, extracting
     * `choices[0].delta.content` tokens and passing them to `onChunk`.
     * Stops on `data: [DONE]`.
     * 
     * @param {ChatMessage[]} messages - The conversation history.
     * @param {string} systemPrompt - System instructions.
     * @param {(chunk: string) => void} onChunk - Callback for each streamed token.
     * @param {AbortSignal} [signal] - Optional abort signal to cancel the stream.
     * @returns {Promise<BrainResponse>} The complete accumulated response.
     * @throws {Error} If the API returns a non-2xx status or network error.
     */
    public async streamResponse(messages: ChatMessage[], systemPrompt: string, onChunk: (chunk: string) => void, signal?: AbortSignal, tools?: any[], options?: BrainOptions): Promise<BrainResponse> {
        return new Promise((resolve, reject) => {
            // Smart URL Construction
            let raw = this.config.endpoint.trim();
            // Remove common copy-paste artifacts (trailing backslash from curl, trailing slash)
            raw = raw.replace(/[/\\]+$/, '').trim();

            let url = raw;
            if (raw.endsWith('/chat/completions')) {
                // User provided full path, trust it.
                url = raw;
            } else if (raw.includes('googleapis.com')) {
                // Google AI Studio OpenAI-compatible format
                // Usually https://generativelanguage.googleapis.com/v1beta/openai
                if (raw.endsWith('/')) url = `${raw}chat/completions`;
                else url = `${raw}/chat/completions`;
            } else if (raw.endsWith('/v1')) {
                // User provided versioned base, just add resource
                url = `${raw}/chat/completions`;
            } else {
                // User likely provided base host, add standard OpenAI path
                url = `${raw}/v1/chat/completions`;
            }

            console.log(`[CloudBrain] Final Request URL: ${url}`); // Debug Log

            const lib = url.startsWith('https') ? https : http;

            // Handle Multimodal Content (Images)
            const allMessages = [
                { role: 'system', content: systemPrompt },
                ...messages.map((m, i) => {
                    const msg: any = { role: m.role, content: m.content };

                    if (m.name) msg.name = m.name;

                    // SLEDGEHAMMER: Force reconcile tool_call_id if missing
                    let effectiveId = m.tool_call_id;
                    if (m.role === 'tool' && !effectiveId && i > 0) {
                        const prev = messages[i - 1];
                        if (prev.role === 'assistant' && prev.tool_calls && prev.tool_calls.length > 0) {
                            effectiveId = prev.tool_calls[0].id;
                            console.log(`[CloudBrain] Sledgehammer: Reconciled missing ID ${effectiveId} for tool message ${i}`);
                        }
                    }
                    if (effectiveId !== undefined) msg.tool_call_id = effectiveId;

                    if (m.tool_calls) {
                        msg.tool_calls = m.tool_calls.map(tc => ({
                            id: tc.id || `call_gen_${Math.random().toString(36).substring(7)}`, // Last resort fallback
                            type: tc.type || 'function',
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string'
                                    ? tc.function.arguments
                                    : JSON.stringify(tc.function.arguments)
                            }
                        }));
                    }

                    // Multimodal (array) content is only supported for 'user' and 'assistant' roles (OpenAI spec)
                    if (m.images && m.images.length > 0 && m.role !== 'tool') {
                        msg.content = [
                            { type: 'text', text: m.content },
                            ...m.images.map(img => ({
                                type: 'image_url',
                                image_url: {
                                    url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`
                                }
                            }))
                        ];
                    }
                    return msg;
                })
            ];

            // FINAL VALIDATION LOG
            console.log(`[CloudBrain] Outgoing Payload - ${allMessages.length} messages`);

            // Broader detection for Reasoning/Next-Gen models (o1, o3, gpt-5, etc)
            // These models reject 'temperature' and 'max_tokens' in favor of 'max_completion_tokens'
            const isReasoningModel = /^(o[13]|gpt-5)/i.test(this.config.model);

            // Build body based on model type (Reasoning models have strict constraints)
            const payload: any = {
                model: this.config.model || 'gpt-4o',
                messages: allMessages,
                stream: true,
                stream_options: { include_usage: true } // Request usage stats in stream
            };

            if (tools && tools.length > 0) {
                payload.tools = tools.map(t => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }
                }));
            }

            if (isReasoningModel) {
                payload.max_completion_tokens = options?.max_tokens || 4096;
            } else {
                payload.max_tokens = options?.max_tokens || 4096;
                payload.temperature = options?.temperature !== undefined ? options.temperature : 0.7;
            }

            // Other options
            if (options?.top_p !== undefined) payload.top_p = options.top_p;
            if (options?.stop) payload.stop = options.stop;

            const body = JSON.stringify(payload);
            let fullContent = "";

            const req = lib.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    let errBody = '';
                    res.on('data', c => errBody += c);
                    res.on('end', () => {
                        console.error(`[CloudBrain] API Error ${res.statusCode}:`, errBody);
                        reject(new Error(`API Error ${res.statusCode}: ${errBody}`));
                    });
                    return;
                }

                let usage: any = undefined;
                let accumulatedToolCalls: any[] = [];

                res.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed === 'data: [DONE]') continue;
                        if (trimmed.startsWith('data: ')) {
                            try {
                                const json = JSON.parse(trimmed.slice(6));

                                // Capture Usage
                                if (json.usage) {
                                    usage = json.usage;
                                }

                                if (json.choices && json.choices[0] && json.choices[0].delta) {
                                    const delta = json.choices[0].delta;

                                    // Text Content
                                    if (delta.content) {
                                        onChunk(delta.content);
                                        fullContent += delta.content;
                                    }

                                    // Tool Calls (OpenAI/Gemini format)
                                    if (delta.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            const idx = tc.index ?? 0;
                                            if (!accumulatedToolCalls[idx]) {
                                                accumulatedToolCalls[idx] = {
                                                    id: tc.id || '',
                                                    type: 'function',
                                                    function: { name: '', arguments: '' }
                                                };
                                            }
                                            if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                                            if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                                            if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                        }
                                    }
                                }
                            } catch (e) {
                                // ignore parse error on partial chunks
                            }
                        }
                    }
                });

                res.on('end', () => {
                    if (usage) {
                        console.log(`[CloudBrain] Completion Usage: ${JSON.stringify(usage, null, 2)}`);
                    }
                    // Filter out any holes in the array and ensure arguments are parsed/ready
                    const toolCalls = accumulatedToolCalls.filter(tc => tc && tc.function.name);
                    resolve({
                        content: fullContent,
                        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                        metadata: { usage }
                    });
                });
            });

            req.on('error', (e: any) => {
                if (e.code === 'ECONNRESET' && signal?.aborted) {
                    console.log('[CloudBrain] Stream aborted by user.');
                    resolve({ content: fullContent || '' }); // Resolve partial on abort
                    return;
                }
                reject(e);
            });

            // Wire up abort signal to destroy the request
            if (signal) {
                signal.addEventListener('abort', () => {
                    console.log('[CloudBrain] Abort signal received, destroying request.');
                    req.destroy();
                }, { once: true });
            }

            req.write(body);
            req.end();
        });
    }
}
