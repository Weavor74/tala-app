import { fetch, Agent } from 'undici';
import path from 'path';
import fs from 'fs';
import type { IBrain, ChatMessage, BrainResponse, BrainOptions } from './IBrain';

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
                            console.error(`[OllamaBrain] Failed to parse tool arguments for ${tc.function.name}:`, args);
                            // Fallback to empty object to satisfy Ollama's strict validation
                            args = {};
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

    async generateResponse(messages: ChatMessage[], systemPrompt?: string, tools?: any[], options?: BrainOptions): Promise<BrainResponse> {
        const body: any = {
            model: this.model,
            messages: this.prepareMessages(messages, systemPrompt),
            stream: false
        };

        if (tools && tools.length > 0) {
            body.tools = tools;
        }

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

    async streamResponse(
        messages: ChatMessage[],
        systemPrompt: string,
        onChunk: (chunk: string) => void,
        signal?: AbortSignal,
        tools?: any[],
        options?: BrainOptions
    ): Promise<BrainResponse> {
        try {
            const body: any = {
                model: this.model,
                messages: this.prepareMessages(messages, systemPrompt),
                stream: true
            };

            if (tools && tools.length > 0) {
                body.tools = tools;
            }

            const internalController = new AbortController();
            const timeoutId = setTimeout(() => internalController.abort(), options?.timeout || 1800000); // 30 minute default

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
            const bodyString = JSON.stringify({ ...body, options: ollamaOptions });
            console.log(`[OllamaBrain] JSON.stringify successful. Length: ${Math.round(bodyString.length / 1024)} KB`);

            console.log(`[OllamaBrain] Calling fetch() to ${this.baseUrl}/api/chat...`);
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: bodyString,
                signal: internalController.signal,
                // @ts-ignore - undici dispatcher support
                dispatcher: this.dispatcher
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorData = await response.text();
                console.error(`[OllamaBrain] Error (${response.status}): ${errorData}`);

                // Save failed request for diagnosis
                try {
                    const debugPath = path.join(process.cwd(), 'ollama_error_debug.json');
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

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            const text = json.message.content;
                            fullContent += text;
                            onChunk(text);
                        }
                        if (json.message?.tool_calls) {
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
            }

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
            if (e.name === 'AbortError') {
                console.log('[OllamaBrain] Stream aborted or timed out.');
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
