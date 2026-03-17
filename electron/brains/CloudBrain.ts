
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

    public configure(baseUrl: string, model: string): void {
        this.config.endpoint = baseUrl;
        this.config.model = model;
    }

    /**
     * Repairs mangled IDs or names that were accidentally concatenated during
     * a previous unstable generation turn.
     * Example: "f-123f-123" -> "f-123"
     */
    private repairMangled(val: any): string {
        if (val === undefined || val === null) return "";
        let s = val.toString().trim();

        // 1. Fix repeating 'function-call-' (Common in Gemini stream fragments)
        if (s.includes('function-call-')) {
            const parts = s.split('function-call-').filter((p: string) => p.trim());
            if (parts.length > 0) {
                const first = parts[0].trim();
                s = first.startsWith('function-call-') ? first : 'function-call-' + first;
            }
        }

        // 2. Fix Concatenated JSON objects (take the last complete block)
        if (s.includes('}{')) {
            const blocks = s.split('}{');
            const last = blocks[blocks.length - 1];
            s = last.startsWith('{') ? last : '{' + last;
        }

        // 3. Deduplicate exact repetition (e.g. "browsebrowse")
        if (s.length > 0 && s.length % 2 === 0) {
            const mid = s.length / 2;
            if (s.substring(0, mid) === s.substring(mid)) {
                s = s.substring(0, mid);
            }
        }

        // 4. Special case for common core tool mangling (including triple concatenation)
        if (s.includes('manage_goals') && s.endsWith('browse')) return 'browse';
        if (s.includes('manage_goals') && s.endsWith('read_file')) return 'read_file';
        if (s.includes('manage_goals') && s.endsWith('terminal')) return 'terminal_run';

        // 5. Strip Antigravity/Agentic internal prefixes if they leaked into history
        s = s.replace(/^default_api:/i, '');

        return s;
    }

    /**
     * Checks if a message is 'poisoned' by previous concatenation bugs.
     * Corrupted turns cause Gemini to return 400 INVALID_ARGUMENT.
     */
    private isPoisonedTurn(m: ChatMessage): boolean {
        const content = m.content || "";
        const toolCallsStr = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
        const name = m.name || "";
        const id = m.tool_call_id || "";

        const combined = (content + toolCallsStr + name + id).toLowerCase();

        // 1. Double core names
        if (combined.includes('manage_goalsmanage_goals')) return true;
        if (combined.includes('browsebrowse')) return true;

        // 2. Fragmented/Glued JSON
        if (toolCallsStr.includes('}{')) return true;

        // 3. Deeply nested triple calls (mangled)
        if (id.includes('function-call-') && id.split('function-call-').length > 3) return true;

        // 4. Antigravity internal tool leakage
        if (combined.includes('default_api:')) return true;

        return false;
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
        console.log(`[CloudBrain] streamResponse invoked`);
        return new Promise((resolve, reject) => {
            console.log(`[CloudBrain] Constructing URL...`);
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

            // SURGICAL REPAIR + PRUNING: 
            // 1. Filter poisoned direct turns.
            // 2. Prune tool results whose parent assistant message was removed.
            const initialClean = messages.filter(m => !this.isPoisonedTurn(m));
            const assistantCallIds = new Set(
                initialClean
                    .filter(m => m.role === 'assistant' && m.tool_calls)
                    .flatMap(m => m.tool_calls!.map(tc => this.repairMangled(tc.id)))
            );

            const cleanMessages = initialClean.filter(m => {
                if (m.role === 'tool') {
                    const tid = this.repairMangled(m.tool_call_id);
                    if (!assistantCallIds.has(tid)) {
                        console.warn('[CloudBrain] Pruning orphaned tool result:', tid);
                        return false;
                    }
                }
                return true;
            });

            const allMessages = [
                { role: 'system', content: systemPrompt },
                ...cleanMessages.map((m, i) => {
                    const msg: any = { role: m.role, content: m.content || "" };

                    // PARANOID RECONCILIATION: Gemini requires non-empty names for tool results.
                    let effectiveId = m.tool_call_id;
                    let effectiveName = m.name;

                    if (m.role === 'tool') {
                        // Look back through CLEAN history to find the original tool call
                        for (let j = i - 1; j >= 0; j--) {
                            const past = cleanMessages[j];
                            if (past.role === 'assistant' && past.tool_calls) {
                                const match = past.tool_calls.find(tc => !effectiveId || this.repairMangled(tc.id) === this.repairMangled(effectiveId));
                                if (match) {
                                    if (!effectiveName) effectiveName = match.function.name;
                                    if (!effectiveId) effectiveId = match.id;
                                    break;
                                }
                            }
                        }

                        // Sanitize Name (Gemini is picky but allows alphanumeric, underscores, dashes, dots, and colons)
                        const finalBase = (effectiveName || m.name || 'unknown_tool').toString();
                        const finalName = this.repairMangled(finalBase);
                        msg.name = finalName.replace(/[^a-zA-Z0-9_:.-]/g, '_') || 'unknown_tool';
                        msg.tool_call_id = this.repairMangled(effectiveId) || `call_err_${Math.random().toString(36).substring(7)}`;

                        // Gemini strictly forbids empty tool content
                        if (!msg.content) msg.content = "Tool executed successfully (no output).";
                    }

                    if (m.tool_calls) {
                        msg.tool_calls = m.tool_calls.map(tc => {
                            if (!tc || !tc.function) return null;
                            const mapped: any = { ...tc };
                            mapped.id = this.repairMangled(tc.id) || `call_gen_${Math.random().toString(36).substring(7)}`;
                            mapped.type = 'function';
                            mapped.function = {
                                name: this.repairMangled(tc.function.name || 'unknown_tool').replace(/[^a-zA-Z0-9_:.-]/g, '_'),
                                arguments: typeof tc.function.arguments === 'string'
                                    ? tc.function.arguments
                                    : JSON.stringify(tc.function.arguments)
                            };

                            // Stability: Move thought_signature from extra_content if present
                            // Gemini Thinking models require this signature for multi-turn tool use.
                            if (mapped.thought_signature === undefined) {
                                if (mapped.extra_content?.google?.thought_signature) {
                                    mapped.thought_signature = mapped.extra_content.google.thought_signature;
                                    // Keep extra_content for now just in case the shim still looks for it
                                } else if (mapped.metadata?.thought_signature) {
                                    mapped.thought_signature = mapped.metadata.thought_signature;
                                }
                            }

                            return mapped;
                        }).filter(Boolean);
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
                model: this.config.model?.trim() || 'gpt-4o',
                messages: allMessages,
                stream: true
            };

            // DEBUG: Log the full outgoing payload (excluding images for brevity)
            console.log(`[CloudBrain] FULL PAYLOAD:`, JSON.stringify({
                ...payload,
                messages: payload.messages.map((m: any) => ({ ...m, content: typeof m.content === 'string' ? m.content.substring(0, 100) + '...' : 'MULTIMODAL' }))
            }, null, 2));

            if (tools && tools.length > 0) {
                payload.tools = tools.map(t => {
                    const func = t.function || t;
                    const rawName = func.name || 'unknown_tool';
                    const mappedFunc: any = {
                        name: rawName.replace(/[^a-zA-Z0-9_:.-]/g, '_'),
                        description: func.description || 'No description provided.',
                        parameters: func.parameters || func.inputSchema || { type: 'object', properties: {} }
                    };
                    if (func.strict !== undefined) {
                        mappedFunc.strict = func.strict;
                    }
                    return {
                        type: 'function',
                        function: mappedFunc
                    };
                });
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
                },
                timeout: 60000 // 60s timeout for cloud response
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
                let lineBuffer = '';
                let isReasoning = false;

                res.on('data', (chunk) => {
                    const decoded = chunk.toString();
                    const lines = (lineBuffer + decoded).split('\n');

                    // The last element is either an empty string (if chunk ended with \n)
                    // or a partial line (if it didn't). Buffer it.
                    lineBuffer = lines.pop() || '';

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

                                    // Text Content (Content or Reasoning/Thought)
                                    const reasoning = delta.reasoning_content || delta.thought || '';
                                    const content = delta.content || '';

                                    if (reasoning) {
                                        if (!isReasoning) {
                                            onChunk('\n> *Thinking*: ');
                                            isReasoning = true;
                                        }
                                        onChunk(reasoning);
                                        fullContent += reasoning;
                                    } else if (content) {
                                        if (isReasoning) {
                                            onChunk('\n\n'); // End thought block
                                            isReasoning = false;
                                        }
                                        onChunk(content);
                                        fullContent += content;
                                    }

                                    // Tool Calls (OpenAI/Gemini format)
                                    if (delta.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            const idx = tc.index ?? 0;
                                            if (!accumulatedToolCalls[idx]) {
                                                accumulatedToolCalls[idx] = {
                                                    id: '',
                                                    type: 'function',
                                                    function: { name: '', arguments: '' }
                                                };
                                            }

                                            const entry = accumulatedToolCalls[idx];

                                            // 1. Atomic properties (overwrite, don't append)
                                            if (tc.id) entry.id = tc.id;
                                            if (tc.type) entry.type = tc.type;

                                            // 2. Fragmented properties (append)
                                            if (tc.function) {
                                                if (tc.function.name) entry.function.name += tc.function.name;
                                                if (tc.function.arguments) entry.function.arguments += tc.function.arguments;
                                            }

                                            // 3. Metadata/Extensions (spread)
                                            for (const key in tc) {
                                                if (['index', 'id', 'type', 'function'].includes(key)) continue;
                                                // For extra fields like 'thought_signature', we overwrite
                                                entry[key] = tc[key];
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                // ignore parse error on partial chunks that didn't get buffered correctly
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
