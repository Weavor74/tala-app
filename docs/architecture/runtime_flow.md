# Runtime Flow

This document outlines the dynamic behavior of the Tala system across various operational phases.

## 1. Application Startup Sequence
The startup sequence ensures that all frontend and backend services are correctly initialized and connected.

1. **Host Launch**: `electron/main.ts` executes.
2. **Service Registry**: Core services (`AgentService`, `ToolService`, `LoggingService`) are instantiated.
3. **MCP Bootstrap**: The `ToolService` scans for configured MCP servers and launches them as sidecar Python processes.
4. **Inference Readiness**: The `scripts/launch-inference.bat` (Ollama) is verified/started.
5. **Window Initialization**: The React renderer (index.html) is loaded into the Chrome frame.
6. **Preload Attachment**: `preload.ts` attaches the secure IPC bridge to the `window` object.

## 2. Agent Turn Loop (Canonical Path)

Every user turn follows a single authoritative path through the runtime. The canonical turn object is
`TurnContext` (defined in `electron/services/router/ContextAssembler.ts`), which carries all state
from input to output delivery.

```
user input
  → IPC dispatch (tala:chat)
  → AgentService.chat()
  → TalaContextRouter.process()       [mode/context assembly]
    → IntentClassifier.classify()     [intent detection]
    → MemoryService.search()          [memory retrieval, gated by mode]
    → MemoryFilter.filter()           [mode-scope isolation]
    → MemoryFilter.resolveContradictions()
    → ContextAssembler.assemble()     [prompt block construction]
    → resolveMemoryWritePolicy()      [mode-aware write decision]
    → auditLogger.info(turn_routed)   [structured telemetry]
  → TurnContext                       [canonical turn carrier]
  → capability/tool gating            [allowedCapabilities, blockedCapabilities]
  → LLM / tool execution              [OllamaBrain / CloudBrain / ToolService]
  → ArtifactRouter.normalizeAgentOutput()  [output channel determination]
    → auditLogger.info(artifact_routed)
  → TurnContext.artifactDecision      [routing decision recorded]
  → GuardrailService                  [output safety check]
  → UI delivery (IPC stream)
```

### TurnContext — Canonical Turn Carrier

`TurnContext` (source: `electron/services/router/ContextAssembler.ts`) is the single structured
object that describes everything known about a turn from start to finish.

| Field | Type | Description |
|-------|------|-------------|
| `turnId` | `string` | Stable identifier for this turn |
| `resolvedMode` | `string` | Active mode: assistant / rp / hybrid |
| `rawInput` | `string` | Unmodified user text |
| `normalizedInput` | `string` | Lower-cased, trimmed text for classification |
| `intent` | `object` | Classified intent with class, confidence, isGreeting |
| `retrieval` | `object` | Memory retrieval outcome (suppressed, approvedCount, excludedCount) |
| `allowedCapabilities` | `ToolCapability[]` | Tools/features allowed for this turn |
| `blockedCapabilities` | `ToolCapability[]` | Tools/features blocked for this turn |
| `selectedTools` | `string[]` | Tools the agent chose to invoke |
| `artifactDecision` | `ArtifactDecision\|null` | Where output was routed and why |
| `memoryWriteDecision` | `MemoryWriteDecision\|null` | Memory write policy and reason |
| `auditMetadata` | `object` | turnStartedAt, correlationId, mcpServicesUsed |
| `errorState` | `TurnErrorState\|null` | Structured error information |

## 3. Mode Routing and Capability Gating

Mode is enforced centrally by `TalaContextRouter.process()`, not scattered across services.

| Mode | Memory Retrieval | Memory Write | Tool Access |
|------|-----------------|--------------|-------------|
| `assistant` | Enabled (filtered by mode_scope) | short_term or long_term | All allowed |
| `rp` | Blocked (RP isolation) | do_not_write | All blocked |
| `hybrid` | Enabled | short_term | All allowed |
| Greeting (any mode) | Suppressed | do_not_write | memory_retrieval blocked |

## 4. Memory Write Policy

Each turn receives a `MemoryWriteDecision` from `TalaContextRouter.resolveMemoryWritePolicy()`.
The decision is included in the `TurnContext` and carried through to the agent for execution.

| Category | When Applied |
|----------|-------------|
| `do_not_write` | RP mode, greeting turns |
| `ephemeral` | Session-only data (not yet used) |
| `short_term` | Hybrid mode, non-technical assistant turns |
| `long_term` | Assistant mode with technical/task intent |
| `user_profile` | Persistent preference data (explicit writes only) |

Every write decision includes a human-readable `reason` field for audit.

`TalaContextRouter` logs the resolved write policy to stdout as:
`[TalaRouter] Memory write policy: <category> — <reason>`.
This is also captured in the `turn_routed` JSONL audit event under the `memoryWriteCategory` field.

## 5. MCP Lifecycle States

`McpService` (source: `electron/services/McpService.ts`) tracks each server through a defined
state machine. The runtime checks `isServiceCallable(serverId)` before invoking MCP-backed tools.

| State | Meaning |
|-------|---------|
| `STARTING` | Connection handshake in progress |
| `CONNECTED` / `READY` | Ready for tool calls |
| `UNAVAILABLE` | Temporarily unreachable |
| `DEGRADED` | Failed health check; exponential backoff retry |
| `FAILED` | Exhausted retries (>8); manual intervention required |
| `DISABLED` | Explicitly disabled by user or policy |

When a service is not `CONNECTED`, the agent degrades gracefully:
- Astro unavailable → continues without emotional modulation
- Memory graph unavailable → falls back to local memory store
- Non-critical services → turn continues, `TurnContext.auditMetadata.mcpServicesUsed` records the gap

## 6. Artifact Output Routing

`ArtifactRouter.normalizeAgentOutput()` (source: `electron/services/ArtifactRouter.ts`) makes
deterministic routing decisions and emits an `artifact_routed` audit event per turn.

| Trigger | Output Channel | Reason |
|---------|---------------|--------|
| User override phrases ("paste it here") | `chat` | raw_content_override |
| File read tool result | `workspace` | tool_result |
| Browser navigation tool result | `browser` | tool_result |
| Message length > 2000 chars | `workspace` | length_threshold |
| HTML message detected | `browser` | html_heuristic |
| Default short response | `chat` | default |

Every `AgentTurnOutput` now includes `routingReason` and `outputChannel` fields.

## 7. Tool Execution Flow

Detailed flow for when an agent decides to perform an action.

1. **Tool Identification**: Agent chooses a tool (e.g., `read_file`).
2. **Readiness Check**: `McpService.isServiceCallable(serverId)` verified before MCP tool calls.
3. **Call Serialization**: Tool name and arguments are passed to `ToolService.executeTool()`.
4. **Registry Lookup**: `ToolService` determines if the tool is "Native" or "MCP".
5. **Execution**:
    - **Native**: Node.js `fs` or `child_process` executes directly.
    - **MCP**: A JSON-RPC call is sent over stdin/stdout to the target Python sidecar.
6. **Response Aggregation**: Success/Error data is returned to the agent's context for the next reasoning step.
7. **Artifact Routing**: `ArtifactRouter` resolves the output channel and emits telemetry.

## 8. Audit Telemetry

Every turn emits structured JSONL audit events via `AuditLogger`:

| Event | When |
|-------|------|
| `turn_routed` | After `TalaContextRouter.process()` completes |
| `artifact_routed` | After `ArtifactRouter.normalizeAgentOutput()` completes |
| `mcp_connect_ok` | After successful MCP server connection |
| `mcp_connect_fail` | After failed MCP server connection |
| `mcp_server_failed` | When a server exhausts retry attempts |
