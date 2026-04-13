/**
 * LocalInferenceOrchestrator — Hardened Lifecycle Manager
 *
 * Phase 2 Trustworthiness Hardening — Objective 8
 *
 * Wraps LocalEngineService with an explicit state machine, readiness checks,
 * configurable timeouts, bounded retry logic, and structured telemetry emission.
 *
 * States (lifecycle):
 *   disabled → starting → ready → busy → degraded → unavailable → failed
 *
 * Invariants:
 * - Requests are rejected when state is not 'ready'.
 * - Stalled requests are interrupted by a configurable timeout.
 * - Retry attempts are bounded and deterministic.
 * - Every state transition emits a structured telemetry event.
 * - Failed inference never corrupts turn state or artifact routing.
 */

import http from 'http';
import { LocalEngineService } from './LocalEngineService';
import { telemetry } from './TelemetryService';
import type { LocalInferenceState, LocalInferenceStatePayload } from '../../shared/telemetry';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LocalInferenceConfig {
    /** TCP port for the llama.cpp server. Default: 8080. */
    port: number;
    /** Milliseconds to wait for the server to become ready. Default: 60_000. */
    startupTimeoutMs: number;
    /** Milliseconds before an active inference request is considered stalled. Default: 30_000. */
    requestTimeoutMs: number;
    /** Maximum retry attempts on transient failure. Default: 2. */
    maxRetries: number;
    /** Milliseconds to wait between retries (linear backoff multiplier). Default: 2_000. */
    retryDelayMs: number;
    /** Readiness probe interval in milliseconds. Default: 500. */
    readinessProbeIntervalMs: number;
}

const DEFAULT_CONFIG: LocalInferenceConfig = {
    port: 8080,
    startupTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
    maxRetries: 2,
    retryDelayMs: 2_000,
    readinessProbeIntervalMs: 500,
};

// ─── Result types ─────────────────────────────────────────────────────────────

export interface InferenceRequestResult {
    success: boolean;
    content?: string;
    durationMs: number;
    modelName: string;
    provider: 'local';
    engine: 'llama.cpp';
    promptTokens?: number;
    completionTokens?: number;
    errorCode?: 'timeout' | 'unavailable' | 'partial_stream' | 'server_error' | 'unknown';
    errorMessage?: string;
    retryCount: number;
}

// ─── LocalInferenceOrchestrator ────────────────────────────────────────────────────

export class LocalInferenceOrchestrator {
    private engine: LocalEngineService;
    private config: LocalInferenceConfig;
    private _state: LocalInferenceState = 'disabled';

    // Metadata tracked for telemetry
    private activeModelPath: string = '';
    private currentTurnId: string = 'global';
    private currentMode: string = 'unknown';

    constructor(engine?: LocalEngineService, config?: Partial<LocalInferenceConfig>) {
        this.engine = engine ?? new LocalEngineService();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ------------------------------------------------------------------
    // State accessor
    // ------------------------------------------------------------------

    public get state(): LocalInferenceState {
        return this._state;
    }

    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------

    private transition(next: LocalInferenceState, reason: string): void {
        const previous = this._state;
        if (previous === next) return;

        this._state = next;

        const payload: LocalInferenceStatePayload = {
            previousState: previous,
            newState: next,
            reason,
            port: this.config.port,
            modelPath: this.activeModelPath || undefined,
        };

        telemetry.operational(
            'local_inference',
            'inference_state_changed',
            next === 'failed' || next === 'unavailable' ? 'error' : next === 'degraded' ? 'warn' : 'info',
            'LocalInferenceOrchestrator',
            `Local inference state: ${previous} → ${next} (${reason})`,
            next === 'failed' ? 'failure' : 'success',
            {
                turnId: this.currentTurnId,
                mode: this.currentMode,
                payload: {
                    previousState: payload.previousState,
                    newState: payload.newState,
                    reason: payload.reason,
                    port: payload.port,
                    modelPath: payload.modelPath,
                },
            }
        );
    }

    // ------------------------------------------------------------------
    // Readiness probe
    // ------------------------------------------------------------------

    /**
     * Probes the llama.cpp /health endpoint.
     * Returns true when the server reports it is ready.
     */
    public async probeReadiness(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const req = http.get(
                `http://127.0.0.1:${this.config.port}/health`,
                { timeout: 2000 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(body) as { status?: string };
                            resolve(json.status === 'ok' || res.statusCode === 200);
                        } catch {
                            resolve(res.statusCode === 200);
                        }
                    });
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    // ------------------------------------------------------------------
    // Startup
    // ------------------------------------------------------------------

    /**
     * Starts the local inference server and waits until it is ready.
     *
     * On success the state transitions to 'ready'.
     * On timeout or error the state transitions to 'failed'.
     */
    public async start(
        modelPath: string,
        options: { contextSize?: number; gpus?: number } = {},
        turnId = 'global',
        mode = 'unknown'
    ): Promise<void> {
        if (this._state === 'ready' || this._state === 'starting') {
            return;
        }

        this.currentTurnId = turnId;
        this.currentMode = mode;
        this.activeModelPath = modelPath;

        this.transition('starting', 'ignite called');

        const startMs = Date.now();

        try {
            const ignitePromise = this.engine.ignite(modelPath, {
                port: this.config.port,
                contextSize: options.contextSize,
                gpus: options.gpus,
            });

            // Race ignite() against startup timeout
            await Promise.race([
                ignitePromise,
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error(`Startup timeout after ${this.config.startupTimeoutMs}ms`)),
                        this.config.startupTimeoutMs
                    )
                ),
            ]);

            const durationMs = Date.now() - startMs;

            telemetry.operational(
                'local_inference',
                'inference_started',
                'info',
                'LocalInferenceOrchestrator',
                `Local inference server started (${durationMs}ms)`,
                'success',
                {
                    turnId,
                    mode,
                    payload: {
                        provider: 'local',
                        engine: 'llama.cpp',
                        modelName: modelPath,
                        streamMode: true,
                        requestDurationMs: durationMs,
                    },
                }
            );

            this.transition('ready', 'server started and probed ready');
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);

            telemetry.operational(
                'local_inference',
                'inference_failed',
                'error',
                'LocalInferenceOrchestrator',
                `Local inference server failed to start: ${errorMessage}`,
                'failure',
                {
                    turnId,
                    mode,
                    payload: {
                        provider: 'local',
                        engine: 'llama.cpp',
                        modelName: modelPath,
                        streamMode: true,
                        errorCode: 'server_error',
                        errorMessage,
                    },
                }
            );

            this.transition('failed', errorMessage);
            throw err;
        }
    }

    // ------------------------------------------------------------------
    // Stop
    // ------------------------------------------------------------------

    public stop(): void {
        this.engine.extinguish();
        this.transition('disabled', 'stop called');
    }

    // ------------------------------------------------------------------
    // Request (with timeout + retry)
    // ------------------------------------------------------------------

    /**
     * Sends a completion request to the local inference server.
     *
     * Enforces:
     * - Readiness check before invocation.
     * - Configurable request timeout.
     * - Bounded retry with linear delay.
     * - Structured success/failure telemetry on every attempt.
     */
    public async request(
        prompt: string,
        modelName: string,
        turnId = 'global',
        mode = 'unknown'
    ): Promise<InferenceRequestResult> {
        this.currentTurnId = turnId;
        this.currentMode = mode;

        if (this._state !== 'ready') {
            const result: InferenceRequestResult = {
                success: false,
                durationMs: 0,
                modelName,
                provider: 'local',
                engine: 'llama.cpp',
                errorCode: 'unavailable',
                errorMessage: `Local inference not ready (state: ${this._state})`,
                retryCount: 0,
            };

            telemetry.operational(
                'local_inference',
                'inference_failed',
                'warn',
                'LocalInferenceOrchestrator',
                `Inference request rejected — not ready (state: ${this._state})`,
                'failure',
                {
                    turnId,
                    mode,
                    payload: result as unknown as Record<string, unknown>,
                }
            );

            return result;
        }

        this.transition('busy', `request for model ${modelName}`);
        const startMs = Date.now();
        let retryCount = 0;

        while (retryCount <= this.config.maxRetries) {
            try {
                telemetry.operational(
                    'local_inference',
                    'inference_started',
                    'info',
                    'LocalInferenceOrchestrator',
                    `Inference request (attempt ${retryCount + 1}/${this.config.maxRetries + 1})`,
                    'success',
                    {
                        turnId,
                        mode,
                        payload: {
                            provider: 'local',
                            engine: 'llama.cpp',
                            modelName,
                            streamMode: false,
                            retryCount,
                        },
                    }
                );

                const content = await this.invokeWithTimeout(prompt, modelName);
                const durationMs = Date.now() - startMs;

                const result: InferenceRequestResult = {
                    success: true,
                    content,
                    durationMs,
                    modelName,
                    provider: 'local',
                    engine: 'llama.cpp',
                    retryCount,
                };

                telemetry.audit(
                    'local_inference',
                    'inference_completed',
                    'LocalInferenceOrchestrator',
                    `Inference completed in ${durationMs}ms`,
                    'success',
                    {
                        turnId,
                        mode,
                        payload: {
                            provider: 'local',
                            engine: 'llama.cpp',
                            modelName,
                            streamMode: false,
                            requestDurationMs: durationMs,
                            retryCount,
                        },
                    }
                );

                this.transition('ready', 'request completed');
                return result;
            } catch (err) {
                const isTimeout = err instanceof Error && err.message.includes('timed out');
                const errorCode = isTimeout ? 'timeout' : 'server_error';
                const errorMessage = err instanceof Error ? err.message : String(err);
                const durationMs = Date.now() - startMs;

                if (isTimeout) {
                    telemetry.audit(
                        'local_inference',
                        'inference_timeout',
                        'LocalInferenceOrchestrator',
                        `Inference request timed out after ${this.config.requestTimeoutMs}ms (attempt ${retryCount + 1})`,
                        'failure',
                        {
                            turnId,
                            mode,
                            payload: {
                                provider: 'local',
                                engine: 'llama.cpp',
                                modelName,
                                requestDurationMs: durationMs,
                                errorCode,
                                retryCount,
                            },
                        }
                    );
                } else {
                    telemetry.operational(
                        'local_inference',
                        'inference_failed',
                        'error',
                        'LocalInferenceOrchestrator',
                        `Inference request failed (attempt ${retryCount + 1}): ${errorMessage}`,
                        'failure',
                        {
                            turnId,
                            mode,
                            payload: {
                                provider: 'local',
                                engine: 'llama.cpp',
                                modelName,
                                requestDurationMs: durationMs,
                                errorCode,
                                errorMessage,
                                retryCount,
                            },
                        }
                    );
                }

                retryCount++;
                if (retryCount > this.config.maxRetries) {
                    // Exhausted retries
                    this.transition(isTimeout ? 'degraded' : 'failed', errorMessage);

                    const finalResult: InferenceRequestResult = {
                        success: false,
                        durationMs: Date.now() - startMs,
                        modelName,
                        provider: 'local',
                        engine: 'llama.cpp',
                        errorCode,
                        errorMessage,
                        retryCount: retryCount - 1,
                    };

                    telemetry.audit(
                        'local_inference',
                        'degraded_fallback',
                        'LocalInferenceOrchestrator',
                        `Local inference exhausted retries — degraded state`,
                        'failure',
                        {
                            turnId,
                            mode,
                            payload: finalResult as unknown as Record<string, unknown>,
                        }
                    );

                    return finalResult;
                }

                await this.delay(this.config.retryDelayMs * retryCount);
            }
        }

        // Should not be reachable
        this.transition('failed', 'unexpected retry loop exit');
        return {
            success: false,
            durationMs: Date.now() - startMs,
            modelName,
            provider: 'local',
            engine: 'llama.cpp',
            errorCode: 'unknown',
            errorMessage: 'Unexpected retry loop exit',
            retryCount,
        };
    }

    // ------------------------------------------------------------------
    // Recovery
    // ------------------------------------------------------------------

    /**
     * Attempts to recover from a 'failed' or 'degraded' state.
     * Probes the server and, if responsive, transitions back to 'ready'.
     * If not responsive, transitions to 'unavailable'.
     */
    public async recover(turnId = 'global', mode = 'unknown'): Promise<boolean> {
        if (this._state !== 'failed' && this._state !== 'degraded') {
            return this._state === 'ready';
        }

        const isReady = await this.probeReadiness();
        if (isReady) {
            this.transition('ready', 'recovery probe succeeded');
            return true;
        }

        this.transition('unavailable', 'recovery probe failed');

        telemetry.operational(
            'local_inference',
            'subsystem_unavailable',
            'warn',
            'LocalInferenceOrchestrator',
            'Local inference is unavailable — recovery probe did not succeed',
            'failure',
            { turnId, mode }
        );

        return false;
    }

    /**
     * Returns a structured status summary for diagnostics.
     */
    public getStatus(): {
        state: LocalInferenceState;
        port: number;
        modelPath: string;
        engineStatus: ReturnType<LocalEngineService['getStatus']>;
    } {
        return {
            state: this._state,
            port: this.config.port,
            modelPath: this.activeModelPath,
            engineStatus: this.engine.getStatus(),
        };
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private invokeWithTimeout(prompt: string, modelName: string): Promise<string> {
        const endpoint = `http://127.0.0.1:${this.config.port}/v1/completions`;

        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`Inference request timed out after ${this.config.requestTimeoutMs}ms`)),
                this.config.requestTimeoutMs
            )
        );

        const requestPromise = new Promise<string>((resolve, reject) => {
            const body = JSON.stringify({ model: modelName, prompt, max_tokens: 512 });
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body).toString(),
                },
            };

            const req = http.request(endpoint, options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk.toString()));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Server returned ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data) as {
                            choices?: Array<{ text?: string }>;
                        };
                        resolve(json.choices?.[0]?.text ?? '');
                    } catch {
                        reject(new Error(`Failed to parse inference response: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', (err: Error) => reject(err));
            req.write(body);
            req.end();
        });

        return Promise.race([requestPromise, timeoutPromise]);
    }

    private delay(ms: number): Promise<void> {
        return new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}

