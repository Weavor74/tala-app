# Contract: inferenceProviderTypes.ts

**Source**: [shared\inferenceProviderTypes.ts](../../shared/inferenceProviderTypes.ts)

## Interfaces

### `InferenceProviderDescriptor`
```typescript
interface InferenceProviderDescriptor {
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
```

### `InferenceProviderCapabilities`
```typescript
interface InferenceProviderCapabilities {
    streaming: boolean;
    toolCalls: boolean;
    vision: boolean;
    embeddings: boolean;
}
```

### `ProviderProbeResult`
```typescript
interface ProviderProbeResult {
    providerId: string;
    reachable: boolean;
    health: InferenceProviderHealth;
    status: InferenceProviderStatus;
    models: string[];
    responseTimeMs: number;
    error?: string;
    reasonCode?: string;
}
```

### `InferenceSelectionRequest`
```typescript
interface InferenceSelectionRequest {
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
```

### `InferenceSelectionResult`
```typescript
interface InferenceSelectionResult {
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
```

### `InferenceExecutionRequest`
```typescript
interface InferenceExecutionRequest {
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
```

### `InferenceExecutionResult`
```typescript
interface InferenceExecutionResult {
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
```

### `InferenceFailureResult`
```typescript
interface InferenceFailureResult {
    code: InferenceFailureCode;
    message: string;
    attemptedProviders: string[];
    fallbackExhausted: boolean;
}
```

### `StreamExecutionState`
```typescript
interface StreamExecutionState {
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
```

### `InferenceProviderInventory`
```typescript
interface InferenceProviderInventory {
    providers: InferenceProviderDescriptor[];
    selectedProviderId?: string;
    lastRefreshed: string;
    refreshing: boolean;
}
```

### `StreamInferenceRequest`
```typescript
interface StreamInferenceRequest {
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
    /**
     * Stream-open timeout in milliseconds — guards the window before the first token arrives.
     * When omitted, InferenceService derives a provider-aware default:
     *   - embedded providers (scope='embedded'): 90 000 ms; 120 000 ms when prompt exceeds 4 000 chars
     *   - local providers (scope='local'): 90 000 ms; 120 000 ms when prompt exceeds 4 000 chars
     *   - cloud providers (scope='cloud'): 15 000 ms
     * Set explicitly only when you need to override the policy.
     */
    openTimeoutMs?: number;
}
```

### `CanonicalToolCall`
```typescript
interface CanonicalToolCall {
    /** Unique identifier for this tool call instance (may be absent for some providers). */
    id?: string;
    /** The type of call — currently only 'function' is supported. */
    type: 'function';
    /** The function name and its arguments as returned by the model. */
    function: {
        /** Name of the function to execute. */
        name: string;
        /**
         * Arguments for the function.
         * Brain implementations may return a pre-parsed object or a raw JSON string;
         * AgentService normalizes both forms before dispatching to ToolService.executeTool().
         */
        arguments: Record<string, unknown> | string;
    }
```

### `StreamInferenceResult`
```typescript
interface StreamInferenceResult {
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
    /**
     * Tool calls requested by the model during this stream.
     * Populated only on successful completion when the model emitted tool calls
     * instead of (or in addition to) prose content.
     */
    toolCalls?: CanonicalToolCall[];
}
```

### `InferenceProviderScope`
```typescript
type InferenceProviderScope =  'local' | 'embedded' | 'cloud';
```

### `InferenceProviderType`
```typescript
type InferenceProviderType = 
    | 'ollama'
    | 'vllm'
    | 'embedded_vllm'
    | 'koboldcpp'
    | 'cloud';
```

### `InferenceTransportType`
```typescript
type InferenceTransportType =  'http_openai_compat' | 'http_ollama' | 'http_kobold' | 'ipc';
```

### `InferenceProviderHealth`
```typescript
type InferenceProviderHealth =  'healthy' | 'degraded' | 'unavailable' | 'unknown';
```

### `InferenceProviderStatus`
```typescript
type InferenceProviderStatus = 
    | 'ready'            // Detected and responding
    | 'configured'       // Configured but probe not yet run
    | 'not_running'      // Configured/installed but process not active
    | 'degraded'         // Responding but with errors
    | 'unavailable'      // Could not be reached
    | 'disabled';
```

### `InferenceFailureCode`
```typescript
type InferenceFailureCode = 
    | 'no_provider'
    | 'provider_unavailable'
    | 'timeout'
    | 'partial_stream'
    | 'server_error'
    | 'policy_violation'
    | 'unknown';
```

### `StreamExecutionStatus`
```typescript
type StreamExecutionStatus = 
    | 'pending'
    | 'opened'
    | 'streaming'
    | 'completed'
    | 'aborted'
    | 'timeout'
    | 'failed';
```

