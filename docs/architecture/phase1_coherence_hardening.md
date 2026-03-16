# Phase 1 Coherence Hardening

**Status**: Implemented  
**Source files**: `electron/services/router/ContextAssembler.ts`, `electron/services/router/TalaContextRouter.ts`, `electron/services/McpService.ts`, `electron/services/ArtifactRouter.ts`, `electron/services/reflection/ReflectionEngine.ts`

## Overview

Phase 1 hardening establishes a single authoritative control path for every user turn.
The goal is runtime coherence: deterministic context assembly, mode-gated capability enforcement,
controlled memory writes, stable MCP lifecycle management, and auditable artifact routing.

## 1. Canonical TurnContext

`TurnContext` (defined in `electron/services/router/ContextAssembler.ts`) is the single structured
object that carries all state for a turn from input to output delivery.

### Required Fields

| Field | Description |
|-------|-------------|
| `turnId` | Stable identifier |
| `resolvedMode` | Active mode (assistant / rp / hybrid) |
| `rawInput` | Unmodified user text |
| `normalizedInput` | Lower-cased, trimmed text used for classification |
| `intent.class` | Classified intent (technical, greeting, coding, etc.) |
| `intent.confidence` | Classification confidence (0–1) |
| `retrieval.suppressed` | Whether memory retrieval was bypassed |
| `retrieval.approvedCount` | Memories that passed filtering |
| `retrieval.excludedCount` | Memories rejected by mode/status policy |
| `allowedCapabilities` | Tools/features permitted for this turn |
| `blockedCapabilities` | Tools/features blocked for this turn |
| `selectedTools` | Tools the agent chose to invoke (populated by AgentService) |
| `artifactDecision` | Output routing decision (populated by ArtifactRouter) |
| `memoryWriteDecision` | Memory write policy + reason (populated by TalaContextRouter) |
| `auditMetadata.turnStartedAt` | Unix timestamp of turn start |
| `auditMetadata.turnCompletedAt` | Unix timestamp of turn completion (null until complete) |
| `auditMetadata.mcpServicesUsed` | MCP server IDs used during this turn |
| `auditMetadata.correlationId` | UUID for cross-service correlation |
| `errorState` | Structured error information (null when healthy) |

## 2. Memory Write Policy

`TalaContextRouter.resolveMemoryWritePolicy()` evaluates every turn and produces a
`MemoryWriteDecision` attached to the `TurnContext`. Decisions are never implicit.

### Policy Rules

| Mode | Intent | Policy |
|------|--------|--------|
| `rp` | Any | `do_not_write` — RP isolation prohibits all memory writes |
| Any | `greeting` | `do_not_write` — No persistent content in greetings |
| `hybrid` | Any substantive | `short_term` — Moderate persistence |
| `assistant` | technical / coding / planning / task_state | `long_term` |
| `assistant` | Other | `short_term` |

### Write Categories

| Category | Meaning |
|----------|---------|
| `do_not_write` | No memory persistence for this turn |
| `ephemeral` | Session-only buffer, cleared on restart |
| `short_term` | TTL-based expiry |
| `long_term` | Persistent memory store |
| `user_profile` | Persistent user preference/profile |

Every `MemoryWriteDecision` includes a mandatory `reason` field for audit traceability.

## 3. MCP Lifecycle States

`McpService` tracks each server through a seven-state model.

| State | Callable | Description |
|-------|----------|-------------|
| `STARTING` | No | Connection handshake in progress |
| `CONNECTED` / `READY` | Yes | Ready for tool invocations |
| `UNAVAILABLE` | No | Temporarily unreachable |
| `DEGRADED` | No | Exponential backoff retry active |
| `FAILED` | No | Exhausted retries; manual intervention required |
| `DISABLED` | No | Explicitly disabled |

`getServiceHealth(id)` returns a `McpServiceHealth` object with the current state, retry count,
and a human-readable `statusMessage`. `isServiceCallable(id)` is the preflight check used by
`AgentService` before invoking MCP-backed tools.

### Graceful Degradation

- Astro unavailable → turn continues without emotional modulation
- Memory graph unavailable → falls back to local memory store
- Non-critical service unavailable → turn proceeds, gap recorded in `auditMetadata.mcpServicesUsed`

## 4. Artifact Routing

`ArtifactRouter.normalizeAgentOutput()` makes deterministic routing decisions.

Every call produces:
- `routingReason` — human-readable description of why the routing happened
- `outputChannel` — one of: `chat`, `workspace`, `browser`, `diff`, `fallback`
- An `artifact_routed` JSONL audit event via `AuditLogger`

Routing priority:
1. Raw-content override (user phrases) → chat
2. Tool result metadata → workspace / browser / diff
3. Message heuristics (HTML, length) → workspace / browser
4. Default → chat

## 5. Mode Routing

Mode is enforced centrally by `TalaContextRouter.process()`.

| Mode | Memory | Write Policy | Capabilities |
|------|--------|-------------|--------------|
| `assistant` | Enabled (mode-filtered) | short_term / long_term | All allowed |
| `rp` | Blocked entirely | do_not_write | All blocked |
| `hybrid` | Enabled | short_term | All allowed |
| Greeting (any) | Suppressed | do_not_write | memory_retrieval blocked |

Mode capability decisions are captured in `TurnContext.allowedCapabilities` and
`TurnContext.blockedCapabilities` and emitted in the `turn_routed` audit event.

## 6. Audit Events

| Event | Component | When |
|-------|-----------|------|
| `turn_routed` | TalaContextRouter | After routing completes; includes mode, intent, capabilities, memory policy, retrieval counts |
| `artifact_routed` | ArtifactRouter | After output routing; includes channel, reason, artifact ID/type |
| `mcp_connect_ok` | McpService | After successful server connection |
| `mcp_connect_fail` | McpService | After failed server connection |
| `mcp_server_failed` | McpService | When server exhausts retry attempts |

## 7. Tests

New tests in `electron/__tests__/router/Phase1Hardening.test.ts` (24 tests):

- **TurnContext canonical structure**: validates all required fields are present and correctly typed
- **Memory write policy**: RP suppression, greeting suppression, hybrid short_term, assistant long_term
- **Mode gating**: RP blocks all, assistant allows all, greeting blocks memory_retrieval
- **MCP health states**: ServerState enum completeness, `isServiceCallable`, `getAllServiceHealth`
- **Artifact routing**: chat routing, raw-content override, length threshold, HTML heuristic, file/browser tool results, stable IDs, routingReason presence

## 8. Known Limitations

- `TurnContext.selectedTools` is initialized to `[]` by the router; `AgentService` is responsible for populating it during tool execution.
- `TurnContext.artifactDecision` starts as `null`; `ArtifactRouter` populates it but the TurnContext is not automatically updated — `AgentService` must copy the routing result back into the context.
- `TurnContext.auditMetadata.turnCompletedAt` starts as `null`; must be set by `AgentService` at turn completion.
- `MemoryWriteDecision.executed` is always `false` from the router; the memory write service must flip it to `true` after execution.
