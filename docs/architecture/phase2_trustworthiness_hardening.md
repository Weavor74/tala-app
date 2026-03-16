# Phase 2 Trustworthiness Hardening

**Status**: Implemented  
**Source files**:
- `shared/telemetry.ts` — canonical telemetry schema
- `electron/services/TelemetryService.ts` — structured event emission utility
- `electron/services/LocalInferenceManager.ts` — hardened local inference lifecycle
- `electron/services/DocumentationIntelligenceService.ts` — runtime doc retrieval with gating
- `electron/services/reflection/ReflectionEngine.ts` — telemetry-driven reflection

## Overview

Phase 2 makes Tala trustworthy in operation, diagnosis, and self-understanding.
The goal is runtime observability: every significant action produces structured,
attributable, reconstructable telemetry; local inference fails gracefully; documentation
is consulted intentionally rather than blindly; and reflection derives conclusions from
real evidence rather than vague intuition.

---

## Objective 6 — Audit / Telemetry

### Canonical Telemetry Schema

Defined in `shared/telemetry.ts`. Every subsystem emits events that conform to the
`CanonicalTelemetryEvent` envelope:

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 UTC |
| `eventId` | UUID v4 |
| `turnId` | Agent turn this event belongs to |
| `correlationId` | Optional cross-service correlation chain |
| `sessionId` | Session grouping key |
| `subsystem` | Emitting subsystem (agent / router / memory / inference / etc.) |
| `eventType` | Specific event (turn_start / inference_failed / reflection_triggered / etc.) |
| `severity` | debug / info / warn / error |
| `mode` | Operating mode at event time |
| `actor` | Service or component name |
| `summary` | Human-readable summary (no sensitive content) |
| `payload` | Structured context (redacted) |
| `status` | success / failure / partial / suppressed / unknown |
| `channel` | audit / operational / debug |

### Event Categories

| Category | When Emitted |
|----------|-------------|
| `turn_start` / `turn_completed` | Agent turn lifecycle |
| `context_assembled` | Router finishes context assembly |
| `mode_applied` | Mode policy applied |
| `memory_retrieved` / `memory_write_decision` | Memory subsystem actions |
| `capability_gated` | Capability blocked by mode policy |
| `mcp_status` / `mcp_tool_invoked` / `mcp_tool_failed` | MCP interactions |
| `inference_started` / `inference_completed` / `inference_failed` / `inference_timeout` | Inference lifecycle |
| `inference_state_changed` | Local inference state machine transition |
| `artifact_routed` / `artifact_suppressed` | Artifact routing decisions |
| `doc_retrieval_started` / `doc_retrieval_completed` / `doc_retrieval_suppressed` / `doc_retrieval_failed` | Documentation intelligence |
| `reflection_triggered` / `reflection_completed` / `reflection_suppressed` | Reflection lifecycle |
| `degraded_fallback` / `subsystem_unavailable` | Failure and degradation states |

### Turn Reconstruction

`TelemetryService.reconstructTurn(events)` assembles a `TurnReconstruction` from a
list of telemetry events. This allows human diagnosis of any turn without raw log
inspection. The reconstruction includes: mode, inference provider/model/duration,
memory retrieval status, doc retrieval sources, reflection trigger state, error presence,
degraded fallback use, and tool call count.

### Redaction Policy

- Raw user content and model prompts are **never** stored in telemetry payloads.
- All payloads pass through `redact()` (`electron/services/log_redact.ts`) before write.
- Sensitive keys (apiKey, token, password, secret, etc.) are masked as `***`.

### Emission Utility

`TelemetryService` (singleton via `telemetry` export) provides:
- `emit()` — full canonical event
- `audit()` — shorthand for audit-channel events
- `operational()` — shorthand for operational-channel events
- `debug()` — shorthand for debug-channel events (silenced in production)
- `reconstructTurn()` — turn reconstruction from event sequence

All events are written via the existing `AuditLogger` JSONL pipeline to preserve
the established audit trail format.

---

## Objective 7 — Documentation Intelligence Runtime Use

### Gating Policy

Documentation retrieval does **not** run on every turn. The `DocumentationIntelligenceService.evaluateGating()` method
applies a keyword-based gating rule before retrieval executes:

```
DOC_RETRIEVAL_PATTERN = /\b(architecture|design|interface|spec|protocol|how does|
  explain|docs?|documentation|logic|engine|service|requirement|traceability|security|
  contract|schema|api|workflow|pipeline|subsystem|capability|memory|artifact|mode|
  reflection|telemetry|inference|audit)\b/i
```

If no keyword matches, retrieval is suppressed with `suppressReason: 'gating_policy'`.

### Runtime Interface

`queryWithGating(query, turnId, mode, maxResults)` is the Phase 2 primary API:

1. Evaluates gating policy
2. If suppressed: emits `doc_retrieval_suppressed` telemetry, returns `{ retrieved: false, ... }`
3. If allowed: executes retrieval, ranks results by score
4. Returns `DocRetrievalResult` with:
   - `citations: DocCitation[]` — attributed to source paths and headings
   - `promptContext: string` — pre-formatted LLM injection block
   - `gatingRuleMatched: string` — which keyword triggered retrieval
   - `durationMs: number` — retrieval latency

### Source Attribution

Every `DocCitation` carries:
- `sourcePath` — relative path of the source document
- `heading` — section heading within the document
- `score` — relevance score for transparency
- `content` — retrieved text

### Telemetry

- `doc_retrieval_started` — debug, emitted at call start
- `doc_retrieval_completed` — audit channel on success
- `doc_retrieval_suppressed` — debug channel on gating or no-results
- `doc_retrieval_failed` — operational/warn when retriever not initialized

### Backward Compatibility

`getRelevantContext()` is preserved but deprecated. It bypasses the gating policy.
New callers should use `queryWithGating()`.

---

## Objective 8 — Local Inference Hardening

### State Machine

`LocalInferenceManager` (`electron/services/LocalInferenceManager.ts`) implements an
explicit named state machine:

```
disabled → starting → ready ⇄ busy → degraded → unavailable
                          └──────────────────→ failed
```

| State | Meaning |
|-------|---------|
| `disabled` | Not started |
| `starting` | `ignite()` in progress |
| `ready` | Server responsive, accepting requests |
| `busy` | Active request in progress |
| `degraded` | Request failed but server may still respond |
| `unavailable` | Recovery probe failed |
| `failed` | Server failed to start or crashed |

Every state transition emits `inference_state_changed` telemetry with previous/new state
and reason.

### Readiness Enforcement

Requests are rejected with `errorCode: 'unavailable'` when state is not `ready`.
Rejection emits `inference_failed` telemetry immediately.

### Timeout Enforcement

- `startupTimeoutMs` (default: 60s) — startup is aborted if server does not respond.
- `requestTimeoutMs` (default: 30s) — active requests are interrupted if stalled.

Both are configurable via `LocalInferenceConfig`.

### Retry Behavior

- `maxRetries` (default: 2) — bounded retry attempts on transient failure.
- `retryDelayMs` (default: 2s, linear) — delay multiplied by attempt number.
- After exhausting retries: state transitions to `degraded`, emits `degraded_fallback`.

### Recovery

`recover(turnId, mode)` probes the `/health` endpoint:
- Success → transitions to `ready`
- Failure → transitions to `unavailable`, emits `subsystem_unavailable`

### Telemetry Emitted

- `inference_state_changed` — on every state transition
- `inference_started` — on each attempt
- `inference_completed` — on success (audit channel)
- `inference_failed` — on error (with errorCode)
- `inference_timeout` — on request timeout (audit channel)
- `degraded_fallback` — on retry exhaustion (audit channel)
- `subsystem_unavailable` — on failed recovery

---

## Objective 9 — Reflection Tied to Telemetry

### Evidence Buffers

`ReflectionEngine` accumulates three types of evidence in process-level static buffers:

| Buffer | Type | Population |
|--------|------|-----------|
| `turnBuffer` | `TurnRecord[]` | Call `ReflectionEngine.recordTurn()` after each turn |
| `errorBuffer` | `string[]` | Console error interceptor (automatic) |
| `toolFailureBuffer` | `{ tool, error }[]` | Call `ReflectionEngine.reportToolFailure()` |
| `telemetrySignalBuffer` | `TelemetrySignal[]` | Call `ReflectionEngine.reportSignal()` |

The `TelemetrySignal` type carries normalized context from subsystems:
- `category`: `inference_failure` / `inference_timeout` / `mcp_instability` / `memory_anomaly` /
  `artifact_mismatch` / `mode_conflict` / `degraded_fallback` / `subsystem_unavailable`
- `subsystem`, `description`, `context` (optional)

### Trigger Rules

`evaluateTriggers()` evaluates named rules in priority order:

| Rule | Threshold |
|------|-----------|
| `repeated_failure` | ≥1 error in buffer |
| `tool_failure` | ≥1 tool failure in buffer |
| `high_error_rate` | error/turn ≥ 30% |
| `degraded_subsystem` | ≥1 degradation signal |

Returns `TriggerEvaluation` with `shouldTrigger`, `triggeredBy`, `anomalyCount`, `failureCount`.

### Reflection Cycle

`runCycle(turnId, mode)`:
1. Always drains `turnBuffer` (latency metrics, not trigger evidence).
2. Calls `evaluateTriggers()` — returns `null` if no triggers met.
3. On trigger: drains error/tool/signal buffers, emits `reflection_triggered`.
4. Generates `observations[]` from errors, tool failures, and signals.
5. Classifies output type:
   - `anomaly_summary` — degraded subsystems detected
   - `regression_warning` — high error rate with timeouts
   - `operational_summary` — tool failures
   - `confidence_limited_observation` — low-rate errors
   - `improvement_candidate` — (future)
6. Persists `ReflectionEvent` via `ArtifactStore`.
7. Emits `reflection_completed` (audit channel).

### Non-Destructive Policy

- Reflection does **not** write authoritative memory or change runtime policy.
- Reflection outputs are persisted to `ArtifactStore` for developer review.
- All reflection activity is auditable via telemetry.

### Telemetry Emitted

- `reflection_triggered` — audit channel with trigger reason and evidence summary
- `reflection_completed` — audit channel with output type and observation count
- `reflection_suppressed` — debug channel when no triggers met

---

## Cross-Cutting Requirements

### Trust Model

All trustworthiness features make Tala more diagnosable without creating fake certainty.
Where evidence is absent, reflection outputs use `confidence_limited_observation` classification.

### Source Attribution

Doc intelligence citations carry `sourcePath` and `heading`. Reflection outputs carry
`triggeredBy` rule name and `evidenceSummary`. Both are available for developer verification.

### Failure Is First-Class

`LocalInferenceState` enum, `DocRetrievalResult.suppressReason`, `TelemetryStatus.suppressed`,
and `TriggerEvaluation.shouldTrigger=false` all represent explicit failure/suppression states.
None of these silently succeed.

### Non-Destructive Refactoring

The existing `AuditLogger` JSONL pipeline is preserved. `TelemetryService` emits through
it rather than replacing it. `getRelevantContext()` on `DocumentationIntelligenceService`
is preserved (deprecated) for backward compatibility.
