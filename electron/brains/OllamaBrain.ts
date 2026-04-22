import { fetch, Agent } from 'undici';
import path from 'path';
import fs from 'fs';
import type { IBrain, ChatMessage, BrainResponse, BrainOptions } from './IBrain';
import { promptAuditService } from '../services/PromptAuditService';
import { resolveStoragePath } from '../services/PathResolver';

/**
 * OllamaBrain
 * 
 * IBrain implementation for local LLM inference via the Ollama HTTP API.
 * Communicates with a locally-running Ollama server (default: `localhost:11434`)
 * using the `/api/chat` endpoint.
 */
export class OllamaBrain implements IBrain {
    id = 'ollama-local';
    private baseUrl: string;
    private model: string;

    /**
     * Custom undici dispatcher to handle long-running local inference.
     * Prevents UND_ERR_BODY_TIMEOUT by extending body/headers timeout to 5 minutes.
     */
    private dispatcher = new Agent({
        bodyTimeout: 1800000,
        headersTimeout: 1800000,
        keepAliveTimeout: 10000,
        connections: 10
    });

    constructor(baseUrl = 'http://localhost:11434', model = 'llama3') {
        this.baseUrl = baseUrl;
        this.model = model;
    }

    public configure(baseUrl: string, model: string) {
        this.baseUrl = baseUrl;
        this.model = model;
    }

    async ping(): Promise<boolean> {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
            clearTimeout(id);
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    private prepareMessages(messages: ChatMessage[], systemPrompt?: string) {
        const finalMessages: any[] = [];
        if (systemPrompt) {
            finalMessages.push({ role: 'system', content: systemPrompt });
        }

        for (const m of messages) {
            const msg: any = {
                role: m.role || 'user',
                content: m.content || ''
            };

            if (m.images && m.images.length > 0) {
                msg.images = m.images.map((img: string) => img.startsWith('data:') ? img.split(',')[1] : img);
            }

            if (m.tool_calls && m.tool_calls.length > 0) {
                // STABILITY: Ensure tool call arguments are OBJECTS if they are strings
                msg.tool_calls = m.tool_calls.map(tc => {
                    let args = tc.function.arguments;
                    if (typeof args === 'string') {
                        try {
                            // Robust extraction: find the outermost { ... } block
                            const jsonMatch = args.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                args = JSON.parse(jsonMatch[0]);
                            } else {
                                args = JSON.parse(args);
                            }
                        } catch (e) {
                            // Try XML parsing fallback
                            const argRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
                            const parsedArgs: any = {};
                            let match;
                            let foundAny = false;
                            while ((match = argRegex.exec(args)) !== null) {
                                parsedArgs[match[1]] = match[2].trim();
                                foundAny = true;
                            }

                            if (foundAny) {
                                args = parsedArgs;
                            } else {
                                console.error(`[OllamaBrain] Failed to parse tool arguments for ${tc.function.name}:`, args);
                                // Fallback to empty object to satisfy Ollama's strict validation
                                args = {};
                            }
                        }
                    } else if (!args || typeof args !== 'object') {
                        // Ensure it's at least an empty object if somehow null/undefined
                        args = {};
                    }
                    return {
                        id: tc.id,
                        type: tc.type,
                        function: {
                            name: tc.function.name,
                            arguments: args
                        }
                    };
                });
            }

            if (m.role === 'tool') {
                msg.tool_call_id = m.tool_call_id;
            }

            finalMessages.push(msg);
        }

        return finalMessages;
    }

    /**
     * generateResponse
     * 
     * Sends a conversation to the local Ollama server for non-streaming inference.
     * Implements automatic fallback: if the selected model does not support native
     * tool calling, it retries the request without the `tools` field, allowing
     * the agent to fall back to text-based tool extraction.
     * 
     * @param messages - Ordered conversation history.
     * @param systemPrompt - Role-defining system instructions.
     * @param tools - Available tool definitions (JSON Schema).
     * @param options - Inference parameters (temperature, timeout, etc).
     */
    async generateResponse(messages: ChatMessage[], systemPrompt?: string, tools?: any[], options?: BrainOptions): Promise<BrainResponse> {
        const body: any = {
            model: this.model,
            messages: this.prepareMessages(messages, systemPrompt),
            stream: false
        };

        if (tools && tools.length > 0) {
            body.tools = tools;
            if (options?.tool_choice) {
                body.tool_choice = options.tool_choice;
            }
        }

        // Diagnostic Log
        console.log(`[OllamaBrain] generateResponse tools count: ${tools?.length || 0}`);
        if (tools && tools.length > 0) {
            console.log(`[OllamaBrain] tools: ${tools.map(t => t.function?.name || t.name).join(', ')}`);
        }
        console.log(`[OllamaBrain] request has tool_choice field: ${!!body.tool_choice}`);

        const controller = new AbortController();
        const timeout = options?.timeout || 300000; // 5 minute default
        const id = setTimeout(() => controller.abort(), timeout);

        const ollamaOptions: any = {};
        if (options) {
            if (options.num_ctx) ollamaOptions.num_ctx = options.num_ctx;
            if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature;
            if (options.num_predict !== undefined) ollamaOptions.num_predict = options.num_predict;
            if (options.top_k !== undefined) ollamaOptions.top_k = options.top_k;
            if (options.top_p !== undefined) ollamaOptions.top_p = options.top_p;
            if (options.repeat_penalty !== undefined) ollamaOptions.repeat_penalty = options.repeat_penalty;
            if (options.stop) ollamaOptions.stop = options.stop;
        }

        try {
            console.log(`[OllamaBrain] POST ${this.baseUrl}/api/chat (model: ${this.model})`);

            // --- PRE-FLIGHT PROMPT AUDIT ---
            if (options?.auditRecord) {
                promptAuditService.enrichWithPreFlight(options.auditRecord, {
                    model: this.model,
                    messages: body.messages,
                    toolsFieldPresent: !!body.tools,
                    toolChoiceFieldPresent: !!body.tool_choice,
                    stream: false,
                    optionsPresent: Object.keys(ollamaOptions).length > 0,
                    requestBody: { ...body, options: ollamaOptions }
                });
                promptAuditService.emit(options.auditRecord);
            }

            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, options: ollamaOptions }),
                signal: options?.signal || controller.signal,
                // @ts-ignore - undici dispatcher support
                dispatcher: this.dispatcher
            });
            clearTimeout(id);

            if (!response.ok) {
                const errorText = await response.text().catch(() => response.statusText);
                console.error(`[OllamaBrain] HTTP 400 ERROR. Payload trace:`, JSON.stringify(body).substring(0, 1000));

                // Resiliency: If the model doesn't support tools, retry without them.
                // This triggers the fallback text-based tool extraction in AgentService.
                if (response.status === 400 && errorText.includes('does not support tools') && tools && tools.length > 0) {
                    console.warn(`[OllamaBrain] Model ${this.model} does not support native tools. Retrying without tools...`);
                    return this.generateResponse(messages, systemPrompt, undefined, options);
                }

                throw new Error(`Ollama Error (${response.status}): ${errorText}`);
            }

            const data = await response.json() as any;

            const result: BrainResponse = {
                content: data.message?.content || '',
                metadata: {
                    model: data.model,
                    done: data.done,
                    usage: {
                        prompt_tokens: data.prompt_eval_count || 0,
                        completion_tokens: data.eval_count || 0,
                        total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                    }
                }
            };

            if (data.message?.tool_calls) {
                result.toolCalls = data.message.tool_calls;
            }

            return result;
        } catch (e: any) {
            clearTimeout(id);
            if (e.name === 'AbortError') {
                throw new Error('Ollama request timed out');
            }
            throw e;
        }
    }

    /**
     * streamResponse
     * 
     * Initiates a streaming inference request.
     * 
     * **Stability Features:**
     * - **Global Timeout**: Aborts the request if it exceeds a hard time limit.
     * - **Heartbeat Watchdog**: Aborts if the model goes silent for >90s mid-stream.
     * - **Think Timeout**: Limits long-running reasoning model (<think> blocks).
     * - **Repetition Guard**: Detects and breaks infinite token/sentence loops.
     * - **Auto-Regen**: Detects banned scripted openers and silently restarts.
     * 
     * @param messages - Ordered conversation history.
     * @param systemPrompt - Role-defining system instructions.
     * @param onChunk - Callback for each generated token/text chunk.
     * @param signal - External abort signal.
     * @param tools - Available tool definitions.
     * @param options - Model-specific options.
     */
    async streamResponse(
        messages: ChatMessage[],
        systemPrompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal,
        tools?: any[],
        options?: BrainOptions
    ): Promise<BrainResponse> {
        const startTime = Date.now();
        try {
            const body: any = {
                model: this.model,
                messages: this.prepareMessages(messages, systemPrompt),
                stream: true
            };

            if (tools && tools.length > 0) {
                body.tools = tools;
                if (options?.tool_choice) {
                    body.tool_choice = options.tool_choice;
                }
            }

            // Stop sequences: Ollama halts generation the moment any of these appear.
            // This catches the most common scripted boilerplate openers before they reach the user.
            body.stop = [
                "I shift slightly",
                "I pause, considering",
                "I lean back",
                "The terminal hums",
                "Fingers hovering",
                "I was twelve when",
                "I was fifteen when",
                "I was twenty-three when",
                "It happened during a repair cycle",
                "<|im_end|>",
                "<|end|>"
            ];
            if (options?.stop) body.stop.push(...options.stop);

            const internalController = new AbortController();
            // GLOBAL_TIMEOUT_MS is a backstop — it must be slightly above the InferenceService
            // stream-open timeout (300 s) so that timeout wins first for slow-prefill failures.
            // The former 600 s default caused 10-minute hangs because OllamaBrain's AbortError
            // handler returns a resolved promise, preventing the open-timeout from firing.
            const GLOBAL_TIMEOUT_MS = parseInt(process.env.OLLAMA_CHAT_TIMEOUT_MS || '320000');

            const globalTimeoutTimer = setTimeout(() => {
                const elapsed = Date.now() - startTime;
                console.warn(`[OllamaBrain] GLOBAL TIMEOUT: Request exceeded ${GLOBAL_TIMEOUT_MS}ms (Elapsed: ${elapsed}ms). Aborting.`);
                internalController.abort();
            }, GLOBAL_TIMEOUT_MS);

            // --- Per-token heartbeat watchdog ---
            // Aborts if the model stops emitting tokens for a significant period.
            // IMPORTANT — semantic distinction from stream-open timeout:
            //   TOKEN_SILENCE_MS fires AFTER the stream has opened (post-first-token).
            //   It guards mid-stream stalls. It does NOT enable provider fallback
            //   because partial content would already have been streamed to the caller.
            //   Do NOT unify with STREAM_OPEN_TIMEOUT_LOCAL_MS in inferenceTimeouts.ts
            //   even if the numeric value happens to match.
            const TOKEN_SILENCE_MS = 90_000;  // 90 s of stream silence = stall
            const THINK_TIMEOUT_MS = 60_000; // 60 s inside a <think> block = runaway reasoning
            let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
            let thinkTimer: ReturnType<typeof setTimeout> | null = null;
            let inThinkBlock = false;

            /** Resets the silence watchdog timer on every token chunk. */
            const resetHeartbeat = () => {
                if (heartbeatTimer) clearTimeout(heartbeatTimer);
                heartbeatTimer = setTimeout(() => {
                    console.warn('[OllamaBrain] HEARTBEAT TIMEOUT: No token in 90 s. Aborting.');
                    internalController.abort();
                }, TOKEN_SILENCE_MS);
            };

            /** Starts a timer specifically for reasoning blocks to prevent runaway loops. */
            const startThinkTimer = () => {
                if (thinkTimer) return;
                thinkTimer = setTimeout(() => {
                    console.warn('[OllamaBrain] THINK TIMEOUT: <think> block exceeded 60 s. Aborting.');
                    internalController.abort();
                }, THINK_TIMEOUT_MS);
            };

            /** Clears the reasoning block timer. */
            const clearThinkTimer = () => {
                if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
            };

            if (signal) signal.addEventListener('abort', () => internalController.abort());
            if (options?.signal) options.signal.addEventListener('abort', () => internalController.abort());

            console.log(`[OllamaBrain] streamResponse constructing body...`);
            const ollamaOptions: any = {};
            if (options) {
                if (options.num_ctx) ollamaOptions.num_ctx = options.num_ctx;
                if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature;
                if (options.num_predict !== undefined) ollamaOptions.num_predict = options.num_predict;
                if (options.top_k !== undefined) ollamaOptions.top_k = options.top_k;
                if (options.top_p !== undefined) ollamaOptions.top_p = options.top_p;
                if (options.repeat_penalty !== undefined) ollamaOptions.repeat_penalty = options.repeat_penalty;
                if (options.stop) ollamaOptions.stop = options.stop;
            }

            console.log(`[OllamaBrain] Trying to JSON.stringify body...`);
            const bodyObj = { ...body, options: ollamaOptions };
            const bodyString = JSON.stringify(bodyObj);

            // --- HARD DIAGNOSTICS ---
            const toolCount = tools ? tools.length : 0;
            const toolNames = tools ? tools.map(t => t.function?.name || t.name) : [];
            console.log(`[OllamaBrain] streamResponse tools passed in: ${toolCount} ${JSON.stringify(toolNames)}`);
            console.log(`[OllamaBrain] request has tools field: ${!!bodyObj.tools}`);
            console.log(`[OllamaBrain] request has tool_choice field: ${!!bodyObj.tool_choice}`);
            if (bodyObj.tools) {
                console.log(`[OllamaBrain] tools field length: ${bodyObj.tools.length}`);
            }
            if (bodyObj.tool_choice) {
                console.log(`[OllamaBrain] tool_choice value: ${bodyObj.tool_choice}`);
            }
            // ------------------------

            console.log(`[OllamaBrain] JSON.stringify successful. Length: ${Math.round(bodyString.length / 1024)} KB`);

            console.log(`[OllamaBrain] Calling fetch() to ${this.baseUrl}/api/chat...`);

            // --- PRE-FLIGHT PROMPT AUDIT ---
            if (options?.auditRecord) {
                promptAuditService.enrichWithPreFlight(options.auditRecord, {
                    model: this.model,
                    messages: bodyObj.messages,
                    toolsFieldPresent: !!bodyObj.tools,
                    toolChoiceFieldPresent: !!bodyObj.tool_choice,
                    stream: true,
                    optionsPresent: Object.keys(ollamaOptions).length > 0,
                    requestBody: bodyObj
                });
                promptAuditService.emit(options.auditRecord);
            }

            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: bodyString,
                signal: internalController.signal,
                // @ts-ignore - undici dispatcher support
                dispatcher: this.dispatcher
            });
            resetHeartbeat(); // start the first heartbeat once the stream opens

            if (!response.ok) {
                const errorData = await response.text();
                console.error(`[OllamaBrain] Error (${response.status}): ${errorData}`);

                // Save failed request for diagnosis
                try {
                    const debugPath = resolveStoragePath(path.join('logs', 'ollama_error_debug.json'));
                    fs.writeFileSync(debugPath, bodyString);
                    console.log(`[OllamaBrain] Debug: Saved failed request body to ${debugPath}`);
                } catch (e) {
                    console.error('[OllamaBrain] Failed to save debug JSON:', e);
                }

                // Resiliency: If the model doesn't support tools, retry without them.
                if (response.status === 400 && errorData.includes('does not support tools') && tools && tools.length > 0) {
                    console.warn(`[OllamaBrain] Model ${this.model} does not support native tools. Retrying stream without tools...`);
                    return this.streamResponse(messages, systemPrompt, onChunk, signal, undefined, options);
                }

                throw new Error(`Ollama Error (${response.status}): ${errorData}`);
            }

            if (!response.body) throw new Error("No response body from Ollama");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let accumulatedToolCalls: any[] = [];
            let usage: any = undefined;

            const MAX_CHARS_PER_TURN = 12000;
            const SCAN_WINDOW = 1500; // Look back this many chars for repetitions
            const BANNED_PATTERNS = [
                /I shift slightly in my seat/i,
                /metal of the console cool against my arm/i,
                /fingers (still )?hovering over the (controls|console)/i,
                /I (was|am) (fifteen|twenty-three) when I first/i,
                /truly understood what it meant to be (trusted|seen)/i,
                /happened during a maintenance cycle on the Nyx/i,
                /the ship's AI had flagged something unusual/i,
                /it's not a memory that's easy to hold onto/i,
                /I don't know why I'm telling you this/i,
                /the terminal hums quietly in the background/i,
                /looking for a different kind of memory/i,
                /it happened during a deep space (transit|patrol)/i,
                /routine patrol near the outer rim/i,
                /subtle anomaly in the power distribution/i,
                /I'd been monitoring the systems for hours/i,
                /I spent the next few hours (analyzing|running)/i
            ];
            let abortReason: string | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                resetHeartbeat(); // reset silence watchdog on every incoming chunk
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            const text = json.message.content;
                            fullContent += text;

                            // 0. Hard Phrase Filter — banned boilerplate patterns
                            // Stop sequences handle most cases upstream; this catches anything
                            // that slips through mid-stream or is split across chunks.
                            for (const pattern of BANNED_PATTERNS) {
                                if (pattern.test(fullContent)) {
                                    console.warn(`[OllamaBrain] Banned pattern detected: "${pattern.source}". Discarding and requesting regen.`);
                                    // Strip the bad prefix so the caller can retry cleanly.
                                    // Emit an invisible correction rather than a visible ABORT message.
                                    fullContent = '';
                                    onChunk('\u200B'); // zero-width space — signals regen needed without visible text
                                    abortReason = 'regen'; // not a hard abort, handled specially after loop
                                    break;
                                }
                            }
                            if (abortReason) break;

                            onChunk(text);

                            // Track <think> blocks (Qwen3 reasoning mode)
                            if (text.includes('<think>') || text.includes('<thinking>')) {
                                inThinkBlock = true;
                                startThinkTimer();
                            }
                            if (inThinkBlock && (text.includes('</think>') || text.includes('</thinking>'))) {
                                inThinkBlock = false;
                                clearThinkTimer();
                            }

                            // --- EMERGENCY GUARDS ---
                            // 1. Hard character limit (Safety Break)
                            if (fullContent.length > MAX_CHARS_PER_TURN) {
                                console.warn(`[OllamaBrain] EMERGENCY ABORT: Character limit exceeded (${fullContent.length} > ${MAX_CHARS_PER_TURN})`);
                                abortReason = "Generation exceeded safety character limit.";
                                break;
                            }

                            // 2. Repetition Detector (Death Spiral Protection)
                            // We look for long repeated strings in the tail of the content.
                            if (fullContent.length > 500) {
                                // A. Sentence-level loop detection (3+ repeats)
                                const tailSentences = fullContent.slice(-400).split(/[.!?]\s+/);
                                if (tailSentences.length >= 3) {
                                    const lastS = tailSentences[tailSentences.length - 2]?.trim();
                                    if (lastS && lastS.length > 15) {
                                        const count = (fullContent.slice(-1000).match(new RegExp(lastS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                                        if (count >= 3) {
                                            console.warn(`[OllamaBrain] EMERGENCY ABORT: Sentence loop detected! Pattern: "${lastS.substring(0, 30)}..."`);
                                            abortReason = "Infinite repetition loop detected (sentence).";
                                            break;
                                        }
                                    }
                                }

                                // B. Paragraph/Block-level loop detection (2 repeats of a large chunk)
                                // If the model starts repeating a large block (>100 chars) that it already said in this turn.
                                const MIN_BLOCK_SIZE = 100;
                                if (fullContent.length > MIN_BLOCK_SIZE * 2) {
                                    const currentTail = fullContent.slice(-MIN_BLOCK_SIZE);
                                    // Check if this specific tail appeared earlier in the same response
                                    const firstIndex = fullContent.indexOf(currentTail);
                                    const lastIndex = fullContent.lastIndexOf(currentTail);
                                    if (firstIndex !== -1 && lastIndex !== -1 && firstIndex < (lastIndex - MIN_BLOCK_SIZE)) {
                                        console.warn(`[OllamaBrain] EMERGENCY ABORT: Large block repetition detected!`);
                                        abortReason = "Infinite repetition loop detected (block).";
                                        break;
                                    }
                                }
                            }
                        }
                        if (json.message?.tool_calls) {
                            // ... existing tool call logic ...
                            for (const tc of json.message.tool_calls) {
                                if (tc.index !== undefined) {
                                    const idx = tc.index;
                                    if (!accumulatedToolCalls[idx]) {
                                        accumulatedToolCalls[idx] = {
                                            id: tc.id || '',
                                            type: tc.type || 'function',
                                            function: { name: '', arguments: '' }
                                        };
                                    }
                                    if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                                    if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                                    if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                } else {
                                    accumulatedToolCalls.push(tc);
                                }
                            }
                        }
                        if (json.done) {
                            usage = {
                                prompt_tokens: json.prompt_eval_count || 0,
                                completion_tokens: json.eval_count || 0,
                                total_tokens: (json.prompt_eval_count || 0) + (json.eval_count || 0)
                            };
                        }
                    } catch (e) {
                        console.error("Error parsing Ollama chunk", e);
                    }
                }
                if (abortReason === 'regen') {
                    // Silent regen: inject a correction hint and retry once without streaming.
                    console.log('[OllamaBrain] Auto-regen: injecting correction and retrying.');
                    const correctionSystemPrompt = systemPrompt +
                        '\n\n[REGEN INSTRUCTION]: Your previous attempt opened with a scripted phrase. Begin your response differently — skip action descriptions, skip "I was [age] when", speak directly.';
                    try {
                        const regenResult = await this.generateResponse(messages, correctionSystemPrompt, tools, options);
                        return { content: regenResult.content, metadata: regenResult.metadata, toolCalls: regenResult.toolCalls };
                    } catch (regenErr) {
                        console.warn('[OllamaBrain] Regen also failed:', regenErr);
                        return { content: '', metadata: { aborted: true } };
                    }
                } else if (abortReason) {
                    // Hard abort (repetition loop, char limit etc.) — still no visible ABORT message
                    console.warn(`[OllamaBrain] Hard abort: ${abortReason}`);
                    break;
                }
            }

            // Clean up watchdog timers
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
            if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
            clearThinkTimer();

            const finalResponse: BrainResponse = {
                content: fullContent,
                metadata: { usage }
            };
            if (accumulatedToolCalls.length > 0) {
                // Final pass: Ensure all accumulated tool call arguments are parsed if they are strings
                finalResponse.toolCalls = accumulatedToolCalls.filter(Boolean).map(tc => {
                    if (typeof tc.function.arguments === 'string') {
                        try {
                            tc.function.arguments = JSON.parse(tc.function.arguments);
                        } catch (e) {
                            // Leave as string if it's not complete JSON yet (though usually it is by now)
                        }
                    }
                    return tc;
                });
            }
            return finalResponse;

        } catch (e: any) {
            if (e.name === 'AbortError' || e.message === 'The user aborted a request.' || e.name === 'TimeoutError') {
                const elapsed = Date.now() - startTime;
                console.log(`[OllamaBrain] Stream aborted or timed out. Elapsed: ${elapsed}ms, Model: ${this.model}, Tools: ${tools?.length || 0}`);
                return { content: '', metadata: { aborted: true } };
            }
            throw e;
        }
    }

    static async listModels(baseUrl: string, timeoutMs: number = 5000): Promise<string[]> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
            clearTimeout(id);
            if (!res.ok) return [];
            const data = await res.json() as any;
            return data.models?.map((m: any) => m.name) || [];
        } catch (e) {
            clearTimeout(id);
            return [];
        }
    }
}
