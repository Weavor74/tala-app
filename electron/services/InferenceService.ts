/**
 * ⚠️ TALA INVARIANT — INFERENCE STREAMING
 *
 * - Stream MUST produce tokens
 * - Do NOT alter request body format without validation
 * - Do NOT introduce blocking or timeouts that kill valid responses
 * - Ollama/local inference must always remain functional
 */
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { WebContents } from 'electron';
import { LocalEngineService } from './LocalEngineService';
import { LocalInferenceOrchestrator } from './LocalInferenceOrchestrator';
import { auditLogger } from './AuditLogger';
import { telemetry } from './TelemetryService';
import { InferenceProviderRegistry, type ProviderRegistryConfig } from './inference/InferenceProviderRegistry';
import { ProviderSelectionService } from './inference/ProviderSelectionService';
import {
    LARGE_PROMPT_CHAR_THRESHOLD,
    STREAM_OPEN_TIMEOUT_LOCAL_MS,
    STREAM_OPEN_TIMEOUT_LOCAL_LARGE_PROMPT_MS,
    STREAM_OPEN_TIMEOUT_EMBEDDED_MS,
    STREAM_OPEN_TIMEOUT_EMBEDDED_LARGE_PROMPT_MS,
    STREAM_OPEN_TIMEOUT_CLOUD_MS,
} from './inference/inferenceTimeouts';
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
import { PolicyDeniedError } from './policy/PolicyGate';
import { enforceSideEffectWithGuardrails } from './policy/PolicyEnforcement';
import { GuardrailCircuitBreakerStore } from './runtime/guardrails/GuardrailCircuitBreaker';
import { executeWithRuntimeGuardrails } from './runtime/guardrails/GuardrailExecutor';
import type { GuardrailFailureKind } from './runtime/guardrails/RuntimeGuardrailTypes';

type SignalCategory = TelemetrySignal['category'];

/**
 * Represents a local AI inference provider detected during a port scan.
 * @deprecated Use InferenceProviderDescriptor from shared/inferenceProviderTypes.ts.
 *   The registry-based InferenceService.refreshProviders() path supersedes scanLocal().
 */
export interface ScannedProvider {
    engine: 'ollama' | 'vllm';
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
 * - Lifecycle management of the embedded vLLM engine
 * - Legacy provider scan API for backward compatibility
 * - Installer flows for external providers (Ollama)
 *
 * Every inference request that touches a local provider must call
 * `selectProvider()` to obtain a validated InferenceSelectionResult before
 * executing. AgentService should never directly probe or switch providers.
 */
export class InferenceService {
    private readonly guardrailBreakerStore = new GuardrailCircuitBreakerStore();

    /**
     * Legacy embedded engine accessor.
     *
     * Instantiated lazily so normal startup does not probe legacy llama-era
     * binaries or emit stale local-engine logs.
     */
    private localEngine: LocalEngineService | null = null;

    /**
     * Legacy lifecycle manager for embedded local-engine controls.
     * Instantiated lazily for backward-compatible IPC handlers only.
     */
    private localInferenceManager: LocalInferenceOrchestrator | null = null;

    /** Provider registry — source of truth for all known/detected providers. */
    private registry: InferenceProviderRegistry;

    /** Deterministic provider selection policy. */
    private selectionService: ProviderSelectionService;

    /** Reference to the embedded vLLM child process, kept to prevent GC and allow cleanup. */
    private _embeddedVllmChild: import('child_process').ChildProcess | null = null;

    constructor(registryConfig?: ProviderRegistryConfig) {
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
     * Counts total character length across all message content strings.
     * Used to scale timeouts for very large prompts.
     */
    private static countPromptChars(messages: any[]): number {
        return messages.reduce((acc: number, m: any) => {
            const content = typeof m?.content === 'string' ? m.content : '';
            return acc + content.length;
        }, 0);
    }

    /**
     * Resolves the stream-open timeout for a given provider.
     *
     * Policy (applied in order):
     * 1. If `req.openTimeoutMs` is explicitly set, honour it unconditionally.
     * 2. Embedded providers (scope='embedded') — CPU inference can be slow to produce
     *    the first token on cold starts. Give it 90 seconds baseline.
     *    For large prompts (>4 000 chars) this extends to 120 seconds.
     * 3. Other local providers (scope='local', e.g. Ollama) — 90 seconds baseline.
     *    Ollama may load the model from disk on a cold start, which can exceed 30 s.
     *    For large prompts (>4 000 chars) this extends to 120 seconds.
     * 4. Cloud providers (scope='cloud') — 15 seconds (network round-trip only).
     *
     * The timeout only guards the pre-first-token window; once streaming has opened
     * it is cleared regardless of how long the full response takes.
     */
    private static resolveOpenTimeout(
        req: StreamInferenceRequest,
        provider: import('../../shared/inferenceProviderTypes').InferenceProviderDescriptor,
        messages: any[]
    ): number {
        if (req.openTimeoutMs !== undefined) return req.openTimeoutMs;

        const promptChars = InferenceService.countPromptChars(messages);

        // Embedded providers get a generous timeout for cold starts.
        if (provider.scope === 'embedded') {
            return promptChars > LARGE_PROMPT_CHAR_THRESHOLD
                ? STREAM_OPEN_TIMEOUT_EMBEDDED_LARGE_PROMPT_MS
                : STREAM_OPEN_TIMEOUT_EMBEDDED_MS;
        }

        // Other local providers (Ollama, vLLM, koboldcpp):
        // Baseline covers cold-start model loading from disk (can exceed former 30 s default).
        // Scale up for large prompts that take longer to prefill.
        if (provider.scope === 'local') {
            return promptChars > LARGE_PROMPT_CHAR_THRESHOLD
                ? STREAM_OPEN_TIMEOUT_LOCAL_LARGE_PROMPT_MS
                : STREAM_OPEN_TIMEOUT_LOCAL_MS;
        }

        // Cloud providers: only network latency matters.
        return STREAM_OPEN_TIMEOUT_CLOUD_MS;
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

            // Tracks when this specific provider attempt started — used to compute first-token latency.
            let attemptStartedAt = 0;

            try {
                const providerBreaker = this.guardrailBreakerStore.get(
                    `inference:${currentProvider.providerId}`,
                    {
                        failureThreshold: 3,
                        resetAfterMs: 15_000,
                    },
                );

                const guarded = await executeWithRuntimeGuardrails<StreamInferenceResult>({
                    domain: 'inference',
                    operationName: 'provider_stream_attempt',
                    targetKey: currentProvider.providerId,
                    executionId: req.turnId,
                    maxAttempts: (req.fallbackAllowed && (req.fallbackProviders?.length ?? 0) > 0) ? 1 : 2,
                    circuitBreaker: providerBreaker,
                    classifyFailure: (error): GuardrailFailureKind => {
                        const errName = error instanceof Error ? error.name : '';
                        if (req.signal?.aborted || errName === 'AbortError') return 'aborted';
                        return (streamOpenedForCurrentProvider && tokensEmitted > 0) ? 'mid_stream' : 'pre_stream_open';
                    },
                    shouldRetry: (error, _attemptNo, failureKind) =>
                        failureKind === 'pre_stream_open' &&
                        !(error instanceof PolicyDeniedError) &&
                        !req.signal?.aborted,
                    shouldCountFailureForCircuit: (error, failureKind) =>
                        !(error instanceof PolicyDeniedError) && failureKind === 'pre_stream_open',
                    execute: async () => {
                        streamOpenedForCurrentProvider = false;
                        tokensEmitted = 0;

                        const attemptController = new AbortController();
                        const combinedAttemptSignals: AbortSignal[] = [attemptController.signal];
                        if (req.signal) combinedAttemptSignals.push(req.signal);
                        const combinedSignal = AbortSignal.any(combinedAttemptSignals);

                        const wrappedOnToken = (chunk: string) => {
                            if (!streamOpenedForCurrentProvider) {
                                streamOpenedForCurrentProvider = true;
                                inferenceDiagnostics.recordStreamActive();
                                const firstTokenLatencyMs = Date.now() - attemptStartedAt;
                                console.log(
                                    `[InferenceService] First token received` +
                                    ` � provider: ${currentProvider.providerId}` +
                                    ` firstTokenLatency: ${firstTokenLatencyMs}ms` +
                                    ` turnId: ${req.turnId}`
                                );
                                telemetry.operational(
                                    'inference',
                                    'stream_opened',
                                    'info',
                                    'InferenceService',
                                    `Stream opened � provider: ${currentProvider.providerId}`,
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

                        const openTimeoutMs = InferenceService.resolveOpenTimeout(req, currentProvider, messages);
                        const promptChars = InferenceService.countPromptChars(messages);
                        attemptStartedAt = Date.now();
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

                        console.log(
                            `[InferenceService] Stream attempt ${attempt + 1}/${candidateProviders.length}` +
                            ` � provider: ${currentProvider.providerId}` +
                            ` scope: ${currentProvider.scope}` +
                            ` type: ${currentProvider.providerType}` +
                            ` openTimeout: ${openTimeoutMs}ms` +
                            ` promptChars: ${promptChars}` +
                            ` turnId: ${req.turnId}`
                        );

                        try {
                            const streamPromise = brain.streamResponse(
                                messages,
                                systemPrompt,
                                wrappedOnToken,
                                combinedSignal,
                                tools,
                                options
                            ).finally(() => {
                                if (openTimeoutHandle) clearTimeout(openTimeoutHandle);
                            });

                            brainResult = await Promise.race([streamPromise, openTimeoutPromise]);
                        } catch (err) {
                            const asError = err instanceof Error ? err : new Error(String(err));
                            if (!attemptController.signal.aborted) {
                                attemptController.abort(asError);
                            }
                            throw err;
                        }

                        await enforceSideEffectWithGuardrails(
                            'inference',
                            {
                                actionKind: 'inference_output',
                                executionId: req.turnId,
                                executionType: 'chat_turn',
                                executionOrigin: 'ipc',
                                executionMode: req.agentMode,
                                targetSubsystem: 'InferenceService',
                                mutationIntent: 'return_output',
                            },
                            {
                                content: brainResult?.content ?? '',
                                toolCalls: (brainResult?.toolCalls?.length ?? 0),
                            },
                        );

                        const completedAt = new Date().toISOString();
                        const durationMs = Date.now() - new Date(startedAt).getTime();

                        telemetry.operational(
                            'inference',
                            'stream_completed',
                            'info',
                            'InferenceService',
                            `Stream completed � provider: ${currentProvider.providerId}, tokens: ${tokensEmitted}`,
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
                            `Inference completed (stream) � provider: ${currentProvider.providerId}`,
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

                        return {
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
                    },
                });

                if (!guarded.ok) {
                    throw (guarded.error ?? new Error(`Stream attempt failed for provider ${currentProvider.providerId}`));
                }

                const successResult = guarded.value as StreamInferenceResult;
                inferenceDiagnostics.recordStreamResult(successResult);
                return successResult;
            } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));

                if (err instanceof PolicyDeniedError) {
                    const completedAt = new Date().toISOString();
                    const durationMs = Date.now() - new Date(startedAt).getTime();
                    const blockedResult: StreamInferenceResult = {
                        success: false,
                        content: '',
                        streamStatus: 'failed',
                        fallbackApplied: false,
                        attemptedProviders,
                        providerId: currentProvider.providerId,
                        providerType: currentProvider.providerType,
                        modelName: currentProvider.preferredModel ?? 'unknown',
                        turnId: req.turnId,
                        startedAt,
                        completedAt,
                        durationMs,
                        isPartial: false,
                        errorCode: 'policy_violation',
                        errorMessage: err.message,
                    };
                    inferenceDiagnostics.recordStreamResult(blockedResult);
                    return blockedResult;
                }

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
     * Returns the LocalInferenceOrchestrator for legacy local-engine IPC callers.
     * IPC handlers and AgentService use this for embedded engine lifecycle.
     */
    public getLocalInferenceOrchestrator(): LocalInferenceOrchestrator {
        if (!this.localInferenceManager) {
            this.localInferenceManager = new LocalInferenceOrchestrator(this.getLocalEngine());
        }
        return this.localInferenceManager;
    }

    /**
     * Returns the legacy LocalEngineService.
     * @deprecated Prefer getLocalInferenceOrchestrator() for state-managed access.
     */
    public getLocalEngine(): LocalEngineService {
        if (!this.localEngine) {
            this.localEngine = new LocalEngineService();
        }
        return this.localEngine;
    }

    /**
     * Resolves the best available Python executable for embedded local inference.
     * Prioritises the project-local inference venv, then
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
     * Canonical embedded startup path.
     *
     * Policy:
     * 1. Attempt embedded_vllm (authoritative embedded engine).
     * 2. Return true on successful startup/adoption.
     */
    public async ensureEmbeddedProviderStarted(options: {
        embeddedVllm?: {
            port?: number;
            modelId?: string;
            startupTimeoutMs?: number;
        };
    } = {}): Promise<boolean> {
        return this.ensureEmbeddedVllmStarted(options.embeddedVllm ?? {});
    }

    /**
     * Ensures the embedded vLLM server is running.
     *
     * Launch strategy:
     * - Adopt an already-running OpenAI-compatible server on the configured port.
     * - Otherwise spawn scripts/run-vllm(.bat|.sh), then poll /v1/models for readiness.
     */
    public async ensureEmbeddedVllmStarted(options: {
        port?: number;
        modelId?: string;
        startupTimeoutMs?: number;
    } = {}): Promise<boolean> {
        const port = options.port ?? 8000;
        const startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
        const endpoint = `http://127.0.0.1:${port}`;
        const modelsUrl = `${endpoint}/v1/models`;

        const modelsReachable = await this._isModelsEndpointReachable(modelsUrl, 2000);
        if (modelsReachable) {
            telemetry.operational(
                'local_inference',
                'inference_started',
                'info',
                'InferenceService',
                `Embedded vLLM already running on port ${port}`,
                'success',
                { payload: { providerId: 'embedded_vllm', port } },
            );
            return true;
        }

        const portOccupied = await this._isPortOccupied(port);
        if (portOccupied) {
            telemetry.operational(
                'local_inference',
                'inference_failed',
                'error',
                'InferenceService',
                `Port ${port} is already in use by a non-inference service - cannot start embedded vLLM`,
                'failure',
                { payload: { providerId: 'embedded_vllm', port } },
            );
            return false;
        }

        const repoRoot = this._resolveRepoRoot();
        const isWin = process.platform === 'win32';
        const launcher = path.join(repoRoot, 'scripts', isWin ? 'run-vllm.bat' : 'run-vllm.sh');

        if (!fs.existsSync(launcher)) {
            telemetry.operational(
                'local_inference',
                'inference_failed',
                'error',
                'InferenceService',
                `Embedded vLLM launcher not found: ${launcher}`,
                'failure',
                { payload: { providerId: 'embedded_vllm', launcher } },
            );
            return false;
        }

        telemetry.operational(
            'local_inference',
            'inference_started',
            'info',
            'InferenceService',
            `Starting embedded vLLM via launcher: ${launcher}`,
            'success',
            { payload: { providerId: 'embedded_vllm', launcher, port, modelId: options.modelId } },
        );

        let processExited = false;
        try {
            const child = isWin
                ? spawn('cmd.exe', ['/c', launcher], {
                    cwd: repoRoot,
                    detached: false,
                    stdio: 'pipe',
                    env: {
                        ...process.env,
                        TALA_NONINTERACTIVE: '1',
                        TALA_VLLM_PORT: String(port),
                        ...(options.modelId ? { TALA_VLLM_MODEL: options.modelId } : {}),
                    },
                })
                : spawn('bash', [launcher], {
                    cwd: repoRoot,
                    detached: false,
                    stdio: 'pipe',
                    env: {
                        ...process.env,
                        TALA_NONINTERACTIVE: '1',
                        TALA_VLLM_PORT: String(port),
                        ...(options.modelId ? { TALA_VLLM_MODEL: options.modelId } : {}),
                    },
                });

            this._embeddedVllmChild = child;

            child.on('error', (err) => {
                processExited = true;
                telemetry.operational(
                    'local_inference',
                    'inference_failed',
                    'error',
                    'InferenceService',
                    `Embedded vLLM process error: ${err.message}`,
                    'failure',
                    { payload: { providerId: 'embedded_vllm', port, error: err.message } },
                );
            });

            child.on('exit', (code, signal) => {
                processExited = true;
                console.warn(`[EmbeddedVllm] Process exited early - code=${code} signal=${signal}`);
            });

            if (child.stdout) {
                child.stdout.on('data', (d: Buffer) => {
                    const line = d.toString().trim();
                    if (line) console.log(`[EmbeddedVllm] ${line}`);
                });
            }
            if (child.stderr) {
                child.stderr.on('data', (d: Buffer) => {
                    const line = d.toString().trim();
                    if (line) console.log(`[EmbeddedVllm] ${line}`);
                });
            }
        } catch (spawnErr) {
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            telemetry.operational(
                'local_inference',
                'inference_failed',
                'error',
                'InferenceService',
                `Failed to spawn embedded vLLM: ${msg}`,
                'failure',
                { payload: { providerId: 'embedded_vllm', port, error: msg } },
            );
            return false;
        }

        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
            if (processExited) {
                telemetry.operational(
                    'local_inference',
                    'inference_failed',
                    'error',
                    'InferenceService',
                    `Embedded vLLM process exited before becoming reachable on port ${port}`,
                    'failure',
                    { payload: { providerId: 'embedded_vllm', port } },
                );
                return false;
            }
            await new Promise<void>((r) => setTimeout(r, 1000));
            if (await this._isModelsEndpointReachable(modelsUrl, 1500)) {
                telemetry.operational(
                    'local_inference',
                    'inference_started',
                    'info',
                    'InferenceService',
                    `Embedded vLLM ready on port ${port}`,
                    'success',
                    { payload: { providerId: 'embedded_vllm', port, modelId: options.modelId } },
                );
                return true;
            }
        }

        telemetry.operational(
            'local_inference',
            'inference_failed',
            'warn',
            'InferenceService',
            `Embedded vLLM startup timed out after ${startupTimeoutMs}ms`,
            'failure',
            { payload: { providerId: 'embedded_vllm', port, startupTimeoutMs } },
        );
        return false;
    }

    private _resolveRepoRoot(): string {
        return typeof app !== 'undefined' ? app.getAppPath() : process.cwd();
    }

    private async _isModelsEndpointReachable(modelsUrl: string, timeoutMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const req = http.get(modelsUrl, { timeout: timeoutMs }, (res) => {
                res.resume();
                resolve((res.statusCode ?? 0) < 400);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    private async _isPortOccupied(port: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(500);
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => { socket.destroy(); resolve(false); });
            socket.once('timeout', () => { socket.destroy(); resolve(false); });
            try {
                socket.connect(port, '127.0.0.1');
            } catch {
                socket.destroy();
                resolve(false);
            }
        });
    }

    /**
     * Legacy embedded local-engine startup path.
     * Disabled as part of local provider migration to `ollama` + `embedded_vllm`.
     */
    public async ensureEmbeddedStarted(
        _modelPath: string,
        options: {
            port?: number;
            startupTimeoutMs?: number;
        } = {}
    ): Promise<boolean> {
        telemetry.operational(
            'local_inference',
            'inference_failed',
            'warn',
            'InferenceService',
            'Legacy local-engine startup path disabled after provider migration.',
            'failure',
            { payload: { port: options.port ?? 8080, startupTimeoutMs: options.startupTimeoutMs ?? 120_000 } },
        );
        return false;
    }

    /**
     * Terminates managed embedded inference child processes if they are running.
     * Safe to call multiple times; a no-op if no process was spawned.
     */
    public killEmbedded(): void {
        if (this._embeddedVllmChild && !this._embeddedVllmChild.killed) {
            this._embeddedVllmChild.kill();
            this._embeddedVllmChild = null;
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

        // 1. Ollama (11434)
        if (await this._checkPort(11434)) {
            const models = await this._fetchOllamaModels('http://127.0.0.1:11434');
            found.push({
                engine: 'ollama',
                endpoint: 'http://127.0.0.1:11434',
                models,
            });
        }

        // 2. LM Studio / vLLM (1234)
        if (await this._checkPort(1234)) {
            const models = await this._fetchOpenAIModels('http://127.0.0.1:1234');
            found.push({
                engine: 'vllm',
                endpoint: 'http://127.0.0.1:1234',
                models,
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


