/**
 * Canonical Inference Provider Types
 *
 * Defines the authoritative type model for provider detection, selection,
 * execution, and failure handling across the TALA inference path.
 *
 * Provider scopes:
 *   local     — external process on the host (Ollama, vLLM, koboldcpp, external llama.cpp)
 *   embedded  — bundled binary managed by LocalEngineService
 *   cloud     — remote API endpoint
 *
 * See docs/architecture/phase3_inference_integration.md for the selection policy
 * and fallback order.
 */

// ─── Provider scope ───────────────────────────────────────────────────────────

export type InferenceProviderScope = 'local' | 'embedded' | 'cloud';

// ─── Provider type ────────────────────────────────────────────────────────────

export type InferenceProviderType =
    | 'ollama'
    | 'llamacpp'
    | 'embedded_llamacpp'
    | 'vllm'
    | 'koboldcpp'
    | 'cloud';

// ─── Transport ────────────────────────────────────────────────────────────────

export type InferenceTransportType = 'http_openai_compat' | 'http_ollama' | 'http_kobold' | 'ipc';

// ─── Provider health ─────────────────────────────────────────────────────────

export type InferenceProviderHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

// ─── Provider status ─────────────────────────────────────────────────────────

/**
 * Runtime status of a detected or configured provider.
 * Distinguishes between configuration state and runtime readiness.
 */
export type InferenceProviderStatus =
    | 'ready'            // Detected and responding
    | 'configured'       // Configured but probe not yet run
    | 'not_running'      // Configured/installed but process not active
    | 'degraded'         // Responding but with errors
    | 'unavailable'      // Could not be reached
    | 'disabled';        // Administratively disabled

// ─── Provider descriptor ─────────────────────────────────────────────────────

/**
 * Full descriptor for a single inference provider entry in the registry.
 * Represents both statically-configured and dynamically-detected providers.
 */
export interface InferenceProviderDescriptor {
    /** Stable unique identifier for this provider entry. */
    providerId: string;
    /** Human-readable display name. */
    displayName: string;
    /** Provider implementation type. */
    providerType: InferenceProviderType;
    /** Scope: local process, embedded binary, or cloud API. */
    scope: InferenceProviderScope;
    /** Transport protocol used for inference requests. */
    transport: InferenceTransportType;
    /** Base endpoint URL (http://host:port or API base). */
    endpoint: string;
    /** Whether this provider is configured by the user or settings. */
    configured: boolean;
    /** Whether this provider was detected by a probe at runtime. */
    detected: boolean;
    /** Whether this provider is currently ready for requests. */
    ready: boolean;
    /** Aggregated health signal from the most recent probe. */
    health: InferenceProviderHealth;
    /** Detailed runtime status. */
    status: InferenceProviderStatus;
    /** Selection priority (lower = higher priority). */
    priority: number;
    /** Capabilities this provider supports. */
    capabilities: InferenceProviderCapabilities;
    /** Available models discovered during probing. */
    models: string[];
    /** Preferred / configured model for this provider. */
    preferredModel?: string;
    /** Optional API key (for cloud providers). */
    apiKey?: string;
    /** When this provider entry was last probed (ISO timestamp). */
    lastProbed?: string;
    /** Error message from the last failed probe, if any. */
    lastProbeError?: string;
}

// ─── Provider capabilities ────────────────────────────────────────────────────

export interface InferenceProviderCapabilities {
    streaming: boolean;
    toolCalls: boolean;
    vision: boolean;
    embeddings: boolean;
}

// ─── Probe result ─────────────────────────────────────────────────────────────

/**
 * Result returned by a provider-specific probe.
 */
export interface ProviderProbeResult {
    providerId: string;
    reachable: boolean;
    health: InferenceProviderHealth;
    status: InferenceProviderStatus;
    models: string[];
    responseTimeMs: number;
    error?: string;
}

// ─── Selection request ────────────────────────────────────────────────────────

/**
 * Inputs for the provider selection policy.
 */
export interface InferenceSelectionRequest {
    /** Explicitly requested provider ID (from user settings or UI). */
    preferredProviderId?: string;
    /** Explicitly requested model ID (from user settings or UI). */
    preferredModelId?: string;
    /** Required capability for this request. */
    requiredCapability?: keyof InferenceProviderCapabilities;
    /** Routing mode override. */
    mode?: 'auto' | 'local-only' | 'cloud-only';
    /** Whether fallback to a different provider is permitted. */
    fallbackAllowed?: boolean;
    /** Turn identifier for telemetry correlation. */
    turnId?: string;
    /** Agent mode for telemetry context. */
    agentMode?: string;
}

// ─── Selection result ────────────────────────────────────────────────────────

/**
 * Output of the provider selection policy.
 * Carries the selected provider and the full reasoning chain for auditability.
 */
export interface InferenceSelectionResult {
    /** Whether a viable provider was found. */
    success: boolean;
    /** The selected provider descriptor, if any. */
    selectedProvider?: InferenceProviderDescriptor;
    /** The actual model name resolved from provider inventory. */
    resolvedModel?: string;
    /** Human-readable reason for the selection decision. */
    reason: string;
    /** Whether a fallback provider was chosen (i.e. preferred was unavailable). */
    fallbackApplied: boolean;
    /** Provider IDs that were considered and rejected during selection. */
    attemptedProviders: string[];
    /** The final execution path description. */
    executionPath: string;
    /** Structured failure when no viable provider exists. */
    failure?: InferenceFailureResult;
}

// ─── Execution request ────────────────────────────────────────────────────────

export interface InferenceExecutionRequest {
    /** The provider to use (from selection result). */
    provider: InferenceProviderDescriptor;
    /** The prompt text or chat messages. */
    prompt: string;
    /** Model name to use (overrides provider default). */
    model?: string;
    /** Maximum tokens to generate. */
    maxTokens?: number;
    /** Optional abort signal for cancellation. */
    signal?: AbortSignal;
    /** Turn identifier for telemetry. */
    turnId?: string;
    /** Agent mode for telemetry. */
    agentMode?: string;
}

// ─── Execution result ────────────────────────────────────────────────────────

export interface InferenceExecutionResult {
    success: boolean;
    content?: string;
    durationMs: number;
    providerId: string;
    providerType: InferenceProviderType;
    modelName: string;
    fallbackApplied: boolean;
    promptTokens?: number;
    completionTokens?: number;
    errorCode?: InferenceFailureCode;
    errorMessage?: string;
    retryCount: number;
}

// ─── Failure codes ────────────────────────────────────────────────────────────

export type InferenceFailureCode =
    | 'no_provider'
    | 'provider_unavailable'
    | 'timeout'
    | 'partial_stream'
    | 'server_error'
    | 'policy_violation'
    | 'unknown';

// ─── Failure result ──────────────────────────────────────────────────────────

export interface InferenceFailureResult {
    code: InferenceFailureCode;
    message: string;
    attemptedProviders: string[];
    fallbackExhausted: boolean;
}

// ─── Stream state ─────────────────────────────────────────────────────────────

export type StreamExecutionStatus =
    | 'pending'
    | 'opened'
    | 'streaming'
    | 'completed'
    | 'aborted'
    | 'timeout'
    | 'failed';

export interface StreamExecutionState {
    status: StreamExecutionStatus;
    providerId: string;
    modelName: string;
    turnId: string;
    startedAt: string;
    completedAt?: string;
    tokensEmitted: number;
    durationMs?: number;
    errorCode?: InferenceFailureCode;
    errorMessage?: string;
}

// ─── Provider inventory ───────────────────────────────────────────────────────

/**
 * The full provider inventory exposed to the app selection process via IPC.
 */
export interface InferenceProviderInventory {
    providers: InferenceProviderDescriptor[];
    selectedProviderId?: string;
    lastRefreshed: string;
    refreshing: boolean;
}

// ─── Stream execution request ─────────────────────────────────────────────────

/**
 * Request parameters for streaming inference through the canonical path.
 */
export interface StreamInferenceRequest {
    /** Pre-selected provider descriptor (from InferenceService.selectProvider()). */
    provider: InferenceProviderDescriptor;
    /** Turn identifier for telemetry correlation. */
    turnId: string;
    /** Correlation ID for multi-step operations. */
    correlationId?: string;
    /** Session ID for grouping events. */
    sessionId?: string;
    /** Agent mode for telemetry context. */
    agentMode?: string;
    /** Whether a bounded fallback is permitted if stream-open fails. */
    fallbackAllowed?: boolean;
    /** Fallback candidate providers (if fallbackAllowed=true). */
    fallbackProviders?: InferenceProviderDescriptor[];
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Stream-open timeout in milliseconds (default: 15000). */
    openTimeoutMs?: number;
}

// ─── Stream execution result ─────────────────────────────────────────────────

/**
 * Final result from a canonical stream execution.
 * Compatible with non-stream InferenceExecutionResult fields.
 */
export interface StreamInferenceResult {
    success: boolean;
    /** Content accumulated from stream tokens. */
    content: string;
    /** Final stream status. */
    streamStatus: StreamExecutionStatus;
    /** Whether a fallback provider was used. */
    fallbackApplied: boolean;
    /** Ordered list of provider IDs that were attempted. */
    attemptedProviders: string[];
    /** Provider ultimately used for the response. */
    providerId: string;
    /** Provider type of the final provider. */
    providerType: InferenceProviderType;
    /** Model name used. */
    modelName: string;
    /** Turn ID this stream belongs to. */
    turnId: string;
    /** ISO timestamp when stream was opened (or attempted). */
    startedAt: string;
    /** ISO timestamp when stream ended (completed, aborted, failed). */
    completedAt: string;
    /** Total duration in milliseconds. */
    durationMs: number;
    /** Whether the result is only partial (stream was aborted after tokens were received). */
    isPartial: boolean;
    /** Token counts if reported by the brain. */
    promptTokens?: number;
    completionTokens?: number;
    /** Failure code if stream did not complete successfully. */
    errorCode?: InferenceFailureCode;
    /** Human-readable failure description. */
    errorMessage?: string;
    /** Raw BrainResponse metadata (model-specific extras). */
    brainMetadata?: Record<string, unknown>;
}
