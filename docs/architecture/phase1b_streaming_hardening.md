# Phase 1B — Canonical Streaming Integration + Inference Reflection Signals

## Overview

Phase 1B closes the streaming gap introduced in Phase 3.

Before this phase, `AgentService.brain.streamResponse()` was called directly, bypassing
`InferenceService` and producing no stream lifecycle telemetry and no reflection signals.

After this phase:
- All streaming requests route through `InferenceService.executeStream()`.
- Full stream lifecycle telemetry is emitted on every real state transition.
- `ReflectionEngine.reportSignal()` is called for stream failures, timeouts, and fallbacks.
- Bounded fallback is applied safely on stream-open failure.
- Partial-output aborts are handled explicitly and do not trigger unsafe retries.

---

## Files Changed

| File | Change |
|------|--------|
| `shared/inferenceProviderTypes.ts` | Added `StreamInferenceRequest` and `StreamInferenceResult` types |
| `electron/services/InferenceService.ts` | Added `executeStream()` canonical streaming method |
| `electron/services/AgentService.ts` | Routed `streamWithBrain()` through `InferenceService.executeStream()`; all `brain.streamResponse()` calls now use `streamWithBrain()` |

## Tests Added

| File | Tests | Coverage |
|------|-------|---------|
| `electron/__tests__/inference/CanonicalStreaming.test.ts` | 9 | Successful stream lifecycle, no failure signals on success, fallback on stream-open failure, no retry after partial output, timeout classification, stream-open timeout, abort classification, provider exhaustion, provider metadata in result |

---

## Canonical Streaming Path

```
AgentService.streamWithBrain()
    → InferenceService.executeStream()
        → telemetry: inference_started
        → [for each attempt]
            → telemetry: provider_fallback_applied  (attempt > 0)
            → ReflectionEngine.reportSignal(degraded_fallback)  (attempt > 0)
            → brain.streamResponse() wrapped in open-timeout race
                → first token received → telemetry: stream_opened
                → success → telemetry: stream_completed, inference_completed
                → error after partial output → telemetry: stream_aborted (warn, partial)
                                             → ReflectionEngine.reportSignal(inference_failure / inference_timeout)
                                             → return StreamInferenceResult { isPartial: true }
                → error before first token → continue to next candidate (if fallbackAllowed)
        → all candidates exhausted →
            → telemetry: inference_failed / inference_timeout
            → telemetry: stream_aborted (error)
            → ReflectionEngine.reportSignal(inference_failure / inference_timeout / degraded_fallback)
            → return StreamInferenceResult { success: false }
```

---

## Stream Execution Types

### `StreamInferenceRequest`

```ts
interface StreamInferenceRequest {
    provider: InferenceProviderDescriptor;  // Pre-selected provider
    turnId: string;
    correlationId?: string;
    sessionId?: string;
    agentMode?: string;
    fallbackAllowed?: boolean;
    fallbackProviders?: InferenceProviderDescriptor[];
    signal?: AbortSignal;
    openTimeoutMs?: number;  // Default: 15000ms — timeout before first token
}
```

### `StreamInferenceResult`

```ts
interface StreamInferenceResult {
    success: boolean;
    content: string;
    streamStatus: StreamExecutionStatus;     // pending|opened|streaming|completed|aborted|timeout|failed
    fallbackApplied: boolean;
    attemptedProviders: string[];
    providerId: string;
    providerType: InferenceProviderType;
    modelName: string;
    turnId: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    isPartial: boolean;                      // true if aborted after partial output
    promptTokens?: number;
    completionTokens?: number;
    errorCode?: InferenceFailureCode;
    errorMessage?: string;
    brainMetadata?: Record<string, unknown>;
}
```

---

## Stream Lifecycle Telemetry

Events emitted (once per state transition, never redundantly):

| Event | When | Channel |
|-------|------|---------|
| `inference_started` | Before first attempt | operational/info |
| `provider_fallback_applied` | Before each fallback attempt | operational/warn |
| `stream_opened` | On first token received | operational/info |
| `stream_completed` | On successful completion | operational/info |
| `inference_completed` | On successful completion | operational/info |
| `stream_aborted` | On failure (before or after first token) | operational/warn or error |
| `inference_failed` | On all-provider failure (not timeout) | operational/error |
| `inference_timeout` | On timeout failure | operational/error |

All events include structured payloads with: `providerId`, `providerType`, `attemptedProviders`,
`fallbackApplied`, `durationMs`, `tokensEmitted` (where applicable), `errorMessage` (on failure).

---

## Fallback Policy

| Scenario | Behavior |
|----------|----------|
| Error before first token (stream-open failure) | Safe to retry on next candidate if `fallbackAllowed=true` |
| Error after partial output (mid-stream failure) | No retry — return partial result with `isPartial=true` |
| Stream-open timeout (no first token within `openTimeoutMs`) | Treated as pre-open failure; fallback applies if allowed |
| Abort signal | `streamStatus=aborted`, no retry |
| All candidates exhausted | `success=false`, structured error result |

---

## Reflection Signal Integration

`ReflectionEngine.reportSignal()` is called with these categories:

| Trigger | Category |
|---------|----------|
| Fallback to another provider | `degraded_fallback` |
| Mid-stream failure, error message includes timeout keyword | `inference_timeout` |
| Mid-stream failure, general error | `inference_failure` |
| All providers exhausted, timeout | `inference_timeout` |
| All providers exhausted, fallback was applied | `degraded_fallback` |
| All providers exhausted, no fallback | `inference_failure` |

Successful stream completions do not produce any reflection signal.

---

## Backward Compatibility

- All existing streaming behavior is preserved. The only change is that `brain.streamResponse()` is now wrapped with telemetry and reflection logic.
- If `InferenceService.selectProvider()` returns no viable provider, `streamWithBrain()` falls back to calling `brain.streamResponse()` directly (preserving pre-existing behavior on misconfigured instances).
- The `streamWithBrain()` helper sets `fallbackAllowed: false` intentionally — provider fallback at mid-turn is unsafe. Stream-start fallback is handled within `executeStream()` via `fallbackProviders`.
- `BrainResponse` metadata (tool calls, usage, etc.) is preserved in `StreamInferenceResult.brainMetadata` and propagated back through `streamWithBrain()` return value.

---

## Known Limitations

- `streamWithBrain()` does not currently pass `fallbackProviders` to `executeStream()`. Stream-start fallback from `AgentService` requires the caller to populate that list. This is deferred.
- Token-by-token partial progress telemetry (`inference_stream_partial`) is not emitted per-token to avoid noise. Token counts are summarized in `stream_completed`.
- Cloud provider streaming is routed through the same path but cloud brain implementations may not honor `AbortSignal` in all cases.
