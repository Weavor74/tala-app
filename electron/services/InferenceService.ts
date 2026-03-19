import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { WebContents } from 'electron';
import { LocalEngineService } from './LocalEngineService';
import { LocalInferenceManager } from './LocalInferenceManager';
import { auditLogger } from './AuditLogger';
import { telemetry } from './TelemetryService';
import { InferenceProviderRegistry, type ProviderRegistryConfig } from './inference/InferenceProviderRegistry';
import { ProviderSelectionService } from './inference/ProviderSelectionService';
import type {
    InferenceSelectionRequest,
    InferenceSelectionResult,
    InferenceProviderInventory,
    StreamInferenceRequest,
    StreamInferenceResult,
    CanonicalToolCall,
} from '../../shared/inferenceProviderTypes';
import { ReflectionEngine, type TelemetrySignal } from './reflection/ReflectionEngine';
import { inferenceDiagnostics } from './InferenceDiagnosticsService';
import type { IBrain, BrainResponse } from '../brains/IBrain';

type SignalCategory = TelemetrySignal['category'];

/**
 * Represents a local AI inference provider detected during a port scan.
 * @deprecated Use InferenceProviderDescriptor from shared/inferenceProviderTypes.ts.
 *   The registry-based InferenceService.refreshProviders() path supersedes scanLocal().
 */
export interface ScannedProvider {
    engine: 'ollama' | 'llamacpp' | 'vllm';
    endpoint: string;
    models: string[];
}

/**
 * InferenceService — Canonical Inference Coordinator
 *
 * Acts as the single authoritative gate for all inference operations in TALA.
 *
 * Responsibilities:
 * - Provider registry management (via InferenceProviderRegistry)
 * - Deterministic provider selection and fallback (via ProviderSelectionService)
 * - Lifecycle management of the embedded llama.cpp engine (via LocalInferenceManager)
 * - Legacy provider scan API for backward compatibility
 * - Installer flows for external providers (Ollama)
 *
 * Every inference request that touches a local provider must call
 * `selectProvider()` to obtain a validated InferenceSelectionResult before
 * executing. AgentService should never directly probe or switch providers.
 */
export class InferenceService {

    /** Legacy embedded engine — kept for IPC handlers that manage it directly. */
    private localEngine: LocalEngineService = new LocalEngineService();

    /**
     * Hardened lifecycle manager for the embedded llama.cpp engine.
     * Authoritative for embedded provider readiness checks, timeouts, and retries.
     */
    private localInferenceManager: LocalInferenceManager;

    /** Provider registry — source of truth for all known/detected providers. */
    private registry: InferenceProviderRegistry;

    /** Deterministic provider selection policy. */
    private selectionService: ProviderSelectionService;

    /** Reference to the embedded llama.cpp child process, kept to prevent GC and allow cleanup. */
    private _embeddedChild: import('child_process').ChildProcess | null = null;

    constructor(registryConfig?: ProviderRegistryConfig) {
        this.localInferenceManager = new LocalInferenceManager(this.localEngine);
        this.registry = new InferenceProviderRegistry(registryConfig ?? {});
        this.selectionService = new ProviderSelectionService(this.registry);
    }

    // ─── Public — registry / selection API ───────────────────────────────────

    /**
     * Returns the current provider inventory.
     * Safe to call at any time; does not run probes.
     */
    public getProviderInventory(): InferenceProviderInventory {
        return this.registry.getInventory();
    }

    /**
     * Runs provider probes and refreshes the registry.
     * Should be called at startup and when settings change.
     */
    public async refreshProviders(turnId?: string, agentMode?: string): Promise<InferenceProviderInventory> {
        const inventory = await this.registry.refresh(turnId, agentMode);
        inferenceDiagnostics.updateFromInventory(inventory);
        return inventory;
    }

    /**
     * Selects the best available provider according to the deterministic policy.
     * Use this before every real inference request.
     */
    public selectProvider(req: InferenceSelectionRequest = {}): InferenceSelectionResult {
        const result = this.selectionService.select(req);
        if (result.selectedProvider) {
            inferenceDiagnostics.recordProviderSelected(result.selectedProvider);
        }
        return result;
    }

    /**
     * Sets the user-selected provider ID in the registry.
     * Validated on the next selectProvider() call.
     */
    public setSelectedProvider(providerId: string | undefined): void {
        this.registry.setSelectedProviderId(providerId);

        // Update diagnostics to reflect the selection change
        const inventory = this.registry.getInventory();
        inferenceDiagnostics.updateFromInventory(inventory);

        telemetry.operational(
            'local_inference',
            'provider_selected',
            'info',
            'InferenceService',
            `User selected provider: ${providerId ?? '(cleared)'}`,
            'success',
            { payload: { providerId } }
        );
    }

    /**
     * Reconfigures the provider registry (e.g., when settings change).
     */
    public reconfigureRegistry(config: ProviderRegistryConfig): void {
        this.registry.reconfigure(config);
    }

    /**
     * Executes a streaming inference request through the canonical path.
     *
     * This is the authoritative streaming entry point for all TALA streaming requests.
     * AgentService must use this method instead of calling brain.streamResponse() directly.
     *
     * Responsibilities:
     * - Emits stream lifecycle telemetry (stream_opened, stream_completed, stream_aborted)
     * - Emits inference lifecycle telemetry (inference_started, inference_completed, inference_failed)
     * - Reports ReflectionEngine signals for failures and timeouts
     * - Implements bounded fallback if stream-open fails and fallback is allowed
     *
     * @param brain - The configured brain instance (IBrain) to use for streaming.
     * @param messages - Conversation messages.
     * @param systemPrompt - System prompt string.
     * @param onToken - Callback invoked for each streamed token.
     * @param req - Stream request metadata (provider, turnId, fallback config, etc.).
     * @param tools - Optional tools array.
     * @param options - Optional brain options.
     * @returns StreamInferenceResult with full lifecycle metadata.
     */
    public async executeStream(
        brain: IBrain,
        messages: any[],
        systemPrompt: string,
        onToken: (chunk: string) => void,
        req: StreamInferenceRequest,
        tools?: any[],
        options?: any
    ): Promise<StreamInferenceResult> {
        const startedAt = new Date().toISOString();
        const attemptedProviders: string[] = [];
        let currentProvider = req.provider;
        let fallbackApplied = false;

        // Record stream start in diagnostics
        inferenceDiagnostics.recordStreamStart(currentProvider.providerId, []);

        telemetry.operational(
            'inference',
            'inference_started',
            'info',
            'InferenceService',
            `Stream inference starting — provider: ${currentProvider.providerId}`,
            'unknown',
            {
                turnId: req.turnId,
                correlationId: req.correlationId,
                sessionId: req.sessionId,
                mode: req.agentMode ?? 'unknown',
                payload: {
                    providerId: currentProvider.providerId,
                    providerType: currentProvider.providerType,
                    streamMode: true,
                    selectedByPolicy: true,
                    fallbackAllowed: req.fallbackAllowed ?? false,
                },
            }
        );

        const candidateProviders = req.fallbackAllowed && req.fallbackProviders
            ? [currentProvider, ...req.fallbackProviders]
            : [currentProvider];

        let lastError: Error | null = null;
        let streamOpenedForCurrentProvider = false;
        let tokensEmitted = 0;
        let brainResult: BrainResponse | null = null;

        for (let attempt = 0; attempt < candidateProviders.length; attempt++) {
            currentProvider = candidateProviders[attempt];
            streamOpenedForCurrentProvider = false;
            tokensEmitted = 0;
            lastError = null;

            if (attempt > 0) {
                fallbackApplied = true;
                telemetry.operational(
                    'inference',
                    'provider_fallback_applied',
                    'warn',
                    'InferenceService',
                    `Stream fallback — switching to provider: ${currentProvider.providerId}`,
                    'partial',
                    {
                        turnId: req.turnId,
                        correlationId: req.correlationId,
                        sessionId: req.sessionId,
                        mode: req.agentMode ?? 'unknown',
                        payload: {
                            providerId: currentProvider.providerId,
                            providerType: currentProvider.providerType,
                            attemptedProviders,
                            fallbackApplied: true,
                        },
                    }
                );

                ReflectionEngine.reportSignal({
                    timestamp: new Date().toISOString(),
                    subsystem: 'local_inference',
                    category: 'degraded_fallback',
                    description: `Stream inference fell back to provider: ${currentProvider.providerId}`,
                    context: {
                        turnId: req.turnId,
                        originalProvider: attemptedProviders[0],
                        fallbackProvider: currentProvider.providerId,
                        providerType: currentProvider.providerType,
                    },
                });
            }

            attemptedProviders.push(currentProvider.providerId);

            // Wrapped token callback — tracks whether stream actually opened
            const wrappedOnToken = (chunk: string) => {
                if (!streamOpenedForCurrentProvider) {
                    streamOpenedForCurrentProvider = true;
                    // Record that stream is now actively flowing
                    inferenceDiagnostics.recordStreamActive();
                    telemetry.operational(
                        'inference',
                        'stream_opened',
                        'info',
                        'InferenceService',
                        `Stream opened — provider: ${currentProvider.providerId}`,
                        'success',
                        {
                            turnId: req.turnId,
                            correlationId: req.correlationId,
                            sessionId: req.sessionId,
                            mode: req.agentMode ?? 'unknown',
                            payload: {
                                providerId: currentProvider.providerId,
                                providerType: currentProvider.providerType,
                                fallbackApplied,
                                attemptedProviders: [...attemptedProviders],
                            },
                        }
                    );
                }
                tokensEmitted++;
                onToken(chunk);
            };

            try {
                const openTimeoutMs = req.openTimeoutMs ?? 15000;

                // Race the brain stream call against an open-timeout.
                // The timeout only applies before the first token is received (stream-open window).
                // Once streamOpenedForCurrentProvider=true the timeout is irrelevant.
                let openTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
                const openTimeoutPromise = new Promise<never>((_, reject) => {
                    openTimeoutHandle = setTimeout(() => {
                        if (!streamOpenedForCurrentProvider) {
                            const err = new Error(`Stream open timeout after ${openTimeoutMs}ms`);
                            err.name = 'StreamOpenTimeoutError';
                            reject(err);
                        }
                    }, openTimeoutMs);
                });

                const streamPromise = brain.streamResponse(
                    messages,
                    systemPrompt,
                    wrappedOnToken,
                    req.signal,
                    tools,
                    options
                ).finally(() => {
                    if (openTimeoutHandle) clearTimeout(openTimeoutHandle);
                });

                brainResult = await Promise.race([streamPromise, openTimeoutPromise]);

                const hasToolCalls = !!(brainResult?.toolCalls?.length);
                console.log(`[BrainResponse] hasToolCalls=${hasToolCalls} toolCalls=[${(brainResult?.toolCalls ?? []).map(tc => tc.function?.name).join(',')}]`);

                const completedAt = new Date().toISOString();
                const durationMs = Date.now() - new Date(startedAt).getTime();

                telemetry.operational(
                    'inference',
                    'stream_completed',
                    'info',
                    'InferenceService',
                    `Stream completed — provider: ${currentProvider.providerId}, tokens: ${tokensEmitted}`,
                    'success',
                    {
                        turnId: req.turnId,
                        correlationId: req.correlationId,
                        sessionId: req.sessionId,
                        mode: req.agentMode ?? 'unknown',
                        payload: {
                            providerId: currentProvider.providerId,
                            providerType: currentProvider.providerType,
                            fallbackApplied,
                            attemptedProviders: [...attemptedProviders],
                            tokensEmitted,
                            durationMs,
                            promptTokens: brainResult?.metadata?.usage?.prompt_tokens,
                            completionTokens: brainResult?.metadata?.usage?.completion_tokens,
                        },
                    }
                );

                telemetry.operational(
                    'inference',
                    'inference_completed',
                    'info',
                    'InferenceService',
                    `Inference completed (stream) — provider: ${currentProvider.providerId}`,
                    'success',
                    {
                        turnId: req.turnId,
                        correlationId: req.correlationId,
                        sessionId: req.sessionId,
                        mode: req.agentMode ?? 'unknown',
                        payload: {
                            providerId: currentProvider.providerId,
                            providerType: currentProvider.providerType,
                            streamMode: true,
                            fallbackApplied,
                            attemptedProviders: [...attemptedProviders],
                            durationMs,
                            promptTokens: brainResult?.metadata?.usage?.prompt_tokens,
                            completionTokens: brainResult?.metadata?.usage?.completion_tokens,
                            totalTokens: brainResult?.metadata?.usage?.total_tokens,
                        },
                    }
                );

                const successResult: StreamInferenceResult = {
                    success: true,
                    content: brainResult?.content ?? '',
                    streamStatus: 'completed',
                    fallbackApplied,
                    attemptedProviders,
                    providerId: currentProvider.providerId,
                    providerType: currentProvider.providerType,
                    modelName: currentProvider.preferredModel ?? 'unknown',
                    turnId: req.turnId,
                    startedAt,
                    completedAt,
                    durationMs,
                    isPartial: false,
                    promptTokens: brainResult?.metadata?.usage?.prompt_tokens,
                    completionTokens: brainResult?.metadata?.usage?.completion_tokens,
                    brainMetadata: brainResult?.metadata,
                    toolCalls: brainResult?.toolCalls?.length ? brainResult.toolCalls : undefined,
                };
                inferenceDiagnostics.recordStreamResult(successResult);
                return successResult;

            } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));

                // If stream opened before error (partial output), do not attempt fallback
                if (streamOpenedForCurrentProvider && tokensEmitted > 0) {
                    const completedAt = new Date().toISOString();
                    const durationMs = Date.now() - new Date(startedAt).getTime();
                    const isAbort = req.signal?.aborted || lastError.name === 'AbortError';
                    const isTimeout = !isAbort && (lastError.name === 'StreamOpenTimeoutError' || lastError.message?.includes('timeout') || lastError.message?.includes('ETIMEDOUT'));

                    const streamStatus: StreamInferenceResult['streamStatus'] =
                        isAbort ? 'aborted' : isTimeout ? 'timeout' : 'failed';

                    const signalCategory: SignalCategory =
                        isTimeout ? 'inference_timeout' : 'inference_failure';

                    telemetry.operational(
                        'inference',
                        'stream_aborted',
                        'warn',
                        'InferenceService',
                        `Stream aborted mid-stream — provider: ${currentProvider.providerId}, tokens: ${tokensEmitted}`,
                        'partial',
                        {
                            turnId: req.turnId,
                            correlationId: req.correlationId,
                            sessionId: req.sessionId,
                            mode: req.agentMode ?? 'unknown',
                            payload: {
                                providerId: currentProvider.providerId,
                                providerType: currentProvider.providerType,
                                fallbackApplied,
                                attemptedProviders: [...attemptedProviders],
                                tokensEmitted,
                                durationMs,
                                errorMessage: lastError.message,
                                streamStatus,
                            },
                        }
                    );

                    ReflectionEngine.reportSignal({
                        timestamp: new Date().toISOString(),
                        subsystem: 'local_inference',
                        category: signalCategory,
                        description: `Mid-stream failure after ${tokensEmitted} tokens — provider: ${currentProvider.providerId}: ${lastError.message}`,
                        context: {
                            turnId: req.turnId,
                            providerId: currentProvider.providerId,
                            providerType: currentProvider.providerType,
                            tokensEmitted,
                            durationMs,
                            fallbackApplied,
                        },
                    });

                    // Do not retry after partial output — return partial result
                    const partialResult: StreamInferenceResult = {
                        success: false,
                        content: '',
                        streamStatus,
                        fallbackApplied,
                        attemptedProviders,
                        providerId: currentProvider.providerId,
                        providerType: currentProvider.providerType,
                        modelName: currentProvider.preferredModel ?? 'unknown',
                        turnId: req.turnId,
                        startedAt,
                        completedAt,
                        durationMs,
                        isPartial: true,
                        errorCode: isTimeout ? 'timeout' : 'partial_stream',
                        errorMessage: lastError.message,
                    };
                    inferenceDiagnostics.recordStreamResult(partialResult);
                    return partialResult;
                }

                // Stream never opened — fallback is safe if allowed and more candidates exist
                const hasMoreCandidates = attempt < candidateProviders.length - 1;
                if (!hasMoreCandidates) {
                    break;
                }
                // Continue to next candidate (fallback)
            }
        }

        // All providers exhausted or non-retryable failure
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(startedAt).getTime();
        const isAbort = req.signal?.aborted || lastError?.name === 'AbortError';
        const isTimeout = !isAbort && (lastError?.name === 'StreamOpenTimeoutError' || lastError?.message?.includes('timeout') || lastError?.message?.includes('ETIMEDOUT'));

        const streamStatus: StreamInferenceResult['streamStatus'] =
            isAbort ? 'aborted' : isTimeout ? 'timeout' : 'failed';

        const eventType = isTimeout ? 'inference_timeout' : 'inference_failed';

        telemetry.operational(
            'inference',
            eventType,
            'error',
            'InferenceService',
            `Stream inference failed — providers attempted: ${attemptedProviders.join(', ')}`,
            'failure',
            {
                turnId: req.turnId,
                correlationId: req.correlationId,
                sessionId: req.sessionId,
                mode: req.agentMode ?? 'unknown',
                payload: {
                    attemptedProviders,
                    fallbackApplied,
                    streamStatus,
                    durationMs,
                    errorMessage: lastError?.message,
                },
            }
        );

        telemetry.operational(
            'inference',
            'stream_aborted',
            'error',
            'InferenceService',
            `Stream aborted (no open) — providers: ${attemptedProviders.join(', ')}`,
            'failure',
            {
                turnId: req.turnId,
                correlationId: req.correlationId,
                sessionId: req.sessionId,
                mode: req.agentMode ?? 'unknown',
                payload: {
                    attemptedProviders,
                    fallbackApplied,
                    streamStatus,
                    durationMs,
                    errorMessage: lastError?.message,
                },
            }
        );

        const signalCategory: SignalCategory =
            isTimeout ? 'inference_timeout'
            : fallbackApplied ? 'degraded_fallback'
            : 'inference_failure';

        ReflectionEngine.reportSignal({
            timestamp: new Date().toISOString(),
            subsystem: 'local_inference',
            category: signalCategory,
            description: `Stream inference failed after ${attemptedProviders.length} provider attempt(s): ${lastError?.message ?? 'unknown error'}`,
            context: {
                turnId: req.turnId,
                attemptedProviders,
                fallbackApplied,
                providerType: currentProvider.providerType,
                durationMs,
            },
        });

        const exhaustedResult: StreamInferenceResult = {
            success: false,
            content: '',
            streamStatus,
            fallbackApplied,
            attemptedProviders,
            providerId: currentProvider.providerId,
            providerType: currentProvider.providerType,
            modelName: currentProvider.preferredModel ?? 'unknown',
            turnId: req.turnId,
            startedAt,
            completedAt,
            durationMs,
            isPartial: false,
            errorCode: isTimeout ? 'timeout' : isAbort ? 'unknown' : 'server_error',
            errorMessage: lastError?.message,
        };
        inferenceDiagnostics.recordStreamResult(exhaustedResult);
        return exhaustedResult;
    }

    // ─── Public — embedded engine management ─────────────────────────────────

    /**
     * Returns the LocalInferenceManager for the embedded llama.cpp engine.
     * IPC handlers and AgentService use this for embedded engine lifecycle.
     */
    public getLocalInferenceManager(): LocalInferenceManager {
        return this.localInferenceManager;
    }

    /**
     * Returns the legacy LocalEngineService.
     * @deprecated Prefer getLocalInferenceManager() for state-managed access.
     */
    public getLocalEngine(): LocalEngineService {
        return this.localEngine;
    }

    /**
     * Resolves the best available Python executable for running the embedded
     * llama_cpp.server. Prioritises the project-local inference venv, then
     * falls back to bundled binaries or a system Python.
     *
     * @param repoRoot - Repository root directory (defaults to process.cwd()).
     */
    public resolveLocalInferencePython(repoRoot?: string): string | undefined {
        const root = repoRoot || (typeof app !== 'undefined' ? app.getAppPath() : process.cwd());
        const isWin = process.platform === 'win32';

        const candidates = [
            // Project-local inference venv (preferred per design)
            path.join(root, 'local-inference', 'venv', 'Scripts', 'python.exe'),
            path.join(root, 'local-inference', 'venv', 'bin', 'python3'),
            path.join(root, 'local-inference', 'venv', 'bin', 'python'),
            // Generic project venv
            path.join(root, 'venv', 'Scripts', 'python.exe'),
            path.join(root, 'venv', 'bin', 'python3'),
            path.join(root, 'venv', 'bin', 'python'),
            // Bundled platform-specific Python
            path.join(root, 'bin', 'python-win', 'python.exe'),
            path.join(root, 'bin', 'python-mac', 'bin', 'python3'),
            path.join(root, 'bin', 'python-linux', 'bin', 'python3'),
            path.join(root, 'bin', 'python-portable', isWin ? 'python.exe' : 'python3'),
            path.join(root, 'bin', 'python-portable', isWin ? 'python.exe' : path.join('bin', 'python3')),
        ];

        return candidates.find(p => fs.existsSync(p));
    }

    /**
     * Ensures the embedded llama.cpp inference server is running.
     *
     * Behaviour:
     * 1. Checks if the server is already up on the configured port.
     * 2. If not, resolves the project-local Python interpreter and spawns
     *    `python -m llama_cpp.server` with the given model.
     * 3. Polls `/health` until the server is ready (up to startupTimeoutMs).
     * 4. Returns true when the server is confirmed ready, false on failure.
     *
     * This is the guaranteed local-baseline path: it fires whenever no external
     * local inference provider is viable, regardless of internet/cloud status.
     */
    public async ensureEmbeddedStarted(
        modelPath: string,
        options: {
            port?: number;
            contextSize?: number;
            pythonPath?: string;
            startupTimeoutMs?: number;
        } = {}
    ): Promise<boolean> {
        const port = options.port ?? 8080;
        const contextSize = options.contextSize ?? 4096;
        // 120 s gives large GGUF models on slow disks enough time to load.
        const startupTimeoutMs = options.startupTimeoutMs ?? 120_000;

        // 1. Check if the server is already running
        const healthUrl = `http://127.0.0.1:${port}/health`;
        const alreadyUp = await new Promise<boolean>((resolve) => {
            const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
                res.resume();
                resolve((res.statusCode ?? 0) < 400);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });

        if (alreadyUp) {
            telemetry.operational('local_inference', 'inference_started', 'info', 'InferenceService',
                `Embedded server already running on port ${port}`, 'success', { payload: { port } });
            return true;
        }

        // 2. Resolve Python executable
        const pythonPath = options.pythonPath || this.resolveLocalInferencePython();
        if (!pythonPath) {
            telemetry.operational('local_inference', 'inference_failed', 'warn', 'InferenceService',
                'Cannot start embedded inference: no Python interpreter found', 'failure', { payload: { port } });
            return false;
        }

        // 3. Verify model file exists
        if (!fs.existsSync(modelPath)) {
            telemetry.operational('local_inference', 'inference_failed', 'warn', 'InferenceService',
                `Cannot start embedded inference: model not found at ${modelPath}`, 'failure',
                { payload: { port, modelPath } });
            return false;
        }

        // 4. Spawn llama_cpp.server
        telemetry.operational('local_inference', 'inference_started', 'info', 'InferenceService',
            `Starting embedded llama.cpp via Python: ${pythonPath}`, 'success',
            { payload: { port, modelPath, pythonPath } });

        let processExited = false;
        try {
            const child = spawn(pythonPath, [
                '-m', 'llama_cpp.server',
                '--model', modelPath,
                '--host', '127.0.0.1',
                '--port', String(port),
                '--n_ctx', String(contextSize),
                '--n_gpu_layers', '0',
            ], {
                detached: false,
                stdio: 'pipe',
            });

            // Retain the reference so the child process is not prematurely garbage-collected
            // and so it can be cleaned up on shutdown.
            this._embeddedChild = child;

            child.on('error', (err) => {
                processExited = true;
                telemetry.operational('local_inference', 'inference_failed', 'error', 'InferenceService',
                    `Embedded llama.cpp process error: ${err.message}`, 'failure',
                    { payload: { port, error: err.message } });
            });

            child.on('exit', (code, signal) => {
                processExited = true;
                console.warn(`[EmbeddedLlamaCpp] Process exited early — code=${code} signal=${signal}`);
            });

            if (child.stdout) {
                child.stdout.on('data', (d: Buffer) => {
                    const line = d.toString().trim();
                    if (line) console.log(`[EmbeddedLlamaCpp] ${line}`);
                });
            }

            if (child.stderr) {
                child.stderr.on('data', (d: Buffer) => {
                    const line = d.toString().trim();
                    if (line) console.log(`[EmbeddedLlamaCpp] ${line}`);
                });
            }
        } catch (spawnErr) {
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            telemetry.operational('local_inference', 'inference_failed', 'error', 'InferenceService',
                `Failed to spawn embedded llama.cpp: ${msg}`, 'failure', { payload: { port, error: msg } });
            return false;
        }

        // 5. Poll until ready or timeout
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
            // Fail fast if the process exited before it became reachable.
            if (processExited) {
                telemetry.operational('local_inference', 'inference_failed', 'error', 'InferenceService',
                    `Embedded llama.cpp process exited before becoming reachable on port ${port}`, 'failure',
                    { payload: { port, modelPath } });
                return false;
            }
            await new Promise<void>(r => setTimeout(r, 1000));
            const ready = await new Promise<boolean>((resolve) => {
                const req = http.get(healthUrl, { timeout: 1500 }, (res) => {
                    res.resume();
                    resolve((res.statusCode ?? 0) < 400);
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
            });
            if (ready) {
                telemetry.operational('local_inference', 'inference_started', 'info', 'InferenceService',
                    `Embedded llama.cpp ready on port ${port}`, 'success', { payload: { port, modelPath } });
                return true;
            }
        }

        telemetry.operational('local_inference', 'inference_failed', 'warn', 'InferenceService',
            `Embedded llama.cpp startup timed out after ${startupTimeoutMs}ms`, 'failure',
            { payload: { port, modelPath, startupTimeoutMs } });
        return false;
    }

    /**
     * Terminates the embedded llama.cpp child process if it is running.
     * Safe to call multiple times; a no-op if no process was spawned.
     */
    public killEmbedded(): void {
        if (this._embeddedChild && !this._embeddedChild.killed) {
            this._embeddedChild.kill();
            this._embeddedChild = null;
        }
    }

    // ─── Legacy — backward-compatible scan ───────────────────────────────────

    /**
     * Scans the host machine for active AI inference providers.
     *
     * @deprecated Use refreshProviders() + getProviderInventory() for the
     *   registry-based path. This method is retained for backward-compatibility
     *   with existing IPC handler callers.
     *
     * @returns A list of detected providers and their supported models.
     */
    public async scanLocal(): Promise<ScannedProvider[]> {
        const found: ScannedProvider[] = [];

        // 1. Built-in Engine
        const localStatus = this.localEngine.getStatus();
        if (localStatus.isRunning) {
            const models = await this._fetchOpenAIModels(`http://127.0.0.1:${localStatus.port}`);
            found.push({
                engine: 'llamacpp',
                endpoint: `http://127.0.0.1:${localStatus.port}`,
                models: models.length > 0 ? models : ['tala-built-in'],
            });
        }

        // 2. Ollama (11434)
        if (await this._checkPort(11434)) {
            const models = await this._fetchOllamaModels('http://127.0.0.1:11434');
            found.push({
                engine: 'ollama',
                endpoint: 'http://127.0.0.1:11434',
                models: models.length > 0 ? models : ['llama3:latest'],
            });
        }

        // 3. Llama.cpp / LocalAI (8080)
        if (await this._checkPort(8080) && localStatus.port !== 8080) {
            const models = await this._fetchOpenAIModels('http://127.0.0.1:8080');
            found.push({
                engine: 'llamacpp',
                endpoint: 'http://127.0.0.1:8080',
                models: models.length > 0 ? models : ['gpt-3.5-turbo'],
            });
        }

        // 4. LM Studio / vLLM (1234)
        if (await this._checkPort(1234)) {
            const models = await this._fetchOpenAIModels('http://127.0.0.1:1234');
            found.push({
                engine: 'vllm',
                endpoint: 'http://127.0.0.1:1234',
                models: models.length > 0 ? models : ['local-model'],
            });
        }

        auditLogger.info('engine_scan_results', 'InferenceService', {
            count: found.length,
            providers: found.map(p => ({ engine: p.engine, endpoint: p.endpoint })),
        });

        return found;
    }

    // ─── Engine installer ─────────────────────────────────────────────────────

    /**
     * Triggers an automated installation flow for an inference engine.
     * Currently supports Ollama on Windows.
     */
    public async installEngine(engineId: string, webContents?: WebContents): Promise<{ success: boolean; error?: string }> {
        if (engineId !== 'ollama') {
            return { success: false, error: 'Installation currently only supported for Ollama.' };
        }

        const url = 'https://ollama.com/download/OllamaSetup.exe';
        const tempDir = app.getPath('temp');
        const dest = path.join(tempDir, 'OllamaSetup.exe');

        try {
            console.log(`[Inference] Starting download: ${url}`);
            await this._downloadFile(url, dest, (progress) => {
                if (webContents) {
                    webContents.send('install-progress', { engineId, progress });
                }
            });

            console.log(`[Inference] Launching installer: ${dest}`);
            const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
            child.unref();

            auditLogger.info('engine_install_start', 'InferenceService', { engineId });
            return { success: true };
        } catch (e: any) {
            auditLogger.error('engine_install_fail', 'InferenceService', { engineId, error: e.message });
            console.error('[Inference] Installation failed:', e);
            return { success: false, error: e.message };
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _checkPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            http.get(`http://127.0.0.1:${port}/`, () => resolve(true)).on('error', () => resolve(false)).end();
        });
    }

    private async _fetchOllamaModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/api/tags`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(Array.isArray(json.models) ? json.models.map((m: any) => m.name) : []);
                    } catch { resolve([]); }
                });
            }).on('error', () => resolve([]));
        });
    }

    private async _fetchOpenAIModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/v1/models`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(Array.isArray(json.data) ? json.data.map((m: any) => m.id) : []);
                    } catch { resolve([]); }
                });
            }).on('error', () => resolve([]));
        });
    }

    private _downloadFile(url: string, dest: string, onProgress: (progress: number) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`Failed to download: ${res.statusCode}`)); return; }
                const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', (chunk: Buffer) => {
                    downloaded += chunk.length;
                    if (totalSize > 0) onProgress(Math.round((downloaded / totalSize) * 100));
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', (err: Error) => { fs.unlink(dest, () => { }); reject(err); });
        });
    }
}
