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

**AgentKernel is the recognized top-level execution shell.** All user-initiated turns enter through
`AgentKernel.execute()` before reaching any downstream service. The kernel runs a 5-stage pipeline
that provides the named seams where future runtime authority boundaries will attach.

```
user input
  → IPC dispatch (chat-message via IpcRouter)
      IpcRouter reads active mode from settings → passes origin='ipc', executionMode=(activeMode) in KernelRequest
  → AgentKernel.execute()                  [top-level execution shell — Phase 2d]
      → normalizeRequest()                 [normalize/validate KernelRequest; preserve origin/executionMode]
      → intake()                           [stamp executionId, startedAt, executionClass;
                                            reads origin/executionMode from request with 'ipc'/'assistant' fallbacks;
                                            emits execution.created → registers ExecutionState → emits execution.accepted via TelemetryBus]
      → classifyExecution()                [PolicyGate top-level admission check → advance state to 'planning'; future: context assembly trigger]
      → runDelegatedFlow()                 [delegate to AgentService.chat(); future: inference/tool/memory coordination]
          → AgentService.chat()
          → TalaContextRouter.process()       [mode/context assembly]
            → IntentClassifier.classify()     [intent detection; lore follow-up carryover if prior turn was lore]
            → MemoryService.search()          [memory retrieval, gated by mode]
            → RagService.searchStructured()   [lore intent only — LTMF/canon lore candidates prepended first]
            → MemoryFilter.filter()           [mode-scope isolation; RP mode allows source=rag for LTMF]
            → MemoryFilter.resolveContradictions()  [lore-aware source ranking: diary/graph > rag > mem0 > chat]
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
      → finalizeExecution()                [record durationMs, build terminal ExecutionState, emit execution.finalizing → execution.completed via TelemetryBus; future: outcome learning, audit records]
      [on policy deny] classifyExecution → blockExecution() in store + emit execution.blocked via TelemetryBus → throw PolicyDeniedError → re-throw (no execution.failed)
      [on error] catch → failExecution() in store + emit execution.failed via TelemetryBus → re-throw
  → chat-done event (carries executionId + executionOrigin from KernelResult.meta)
```

### AgentKernel — Execution Shell

`AgentKernel` (`electron/services/kernel/AgentKernel.ts`) is the stable top-level execution shell.
It does not replace any subsystem; it coordinates the entrypoint and owns the lifecycle frame around
each turn. Future runtime authority boundaries attach here:

| Stage | Current behavior | Future responsibility |
|-------|-----------------|----------------------|
| `normalizeRequest` | Coerce missing fields to defaults | Request ACL, payload coercion |
| `intake` | Stamp `executionId`, `startedAt`, `executionType='chat_turn'`, `origin='ipc'`, `mode='assistant'`, `executionClass='standard'`; emit `execution.created` and `execution.accepted` via `TelemetryBus` | Budget checks, authority pre-validation |
| `classifyExecution` | PolicyGate top-level admission check (`policyGate.evaluate()` with `action='execution.admit'`). On deny: marks state `blocked`, emits `execution.blocked`, throws `PolicyDeniedError`. On allow: advances state to `planning/classifying`. | Mode detection, context assembly |
| `runDelegatedFlow` | Calls `AgentService.chat()`; `policyGate.assertSideEffect()` is called before each `tools.executeTool()` invocation (stub allow-all; future enforcement attaches here without further changes) | Inference orchestration, tool execution, memory write coordination |
| `finalizeExecution` | Record `durationMs`, build terminal `ExecutionState` (shared contracts), emit `execution.finalizing` then `execution.completed` via `TelemetryBus`, return `KernelResult` | Outcome learning, audit record |

`KernelResult` extends `AgentTurnOutput` with a `meta: KernelExecutionMeta` field containing
`executionId`, `startedAt`, `executionType`, `executionClass`, `durationMs`, `origin`, and `mode`.
The `executionId` and `executionOrigin` are forwarded to the renderer in the `chat-done` IPC event
for turn-level log correlation. `KernelResult` also carries a terminal `executionState: ExecutionState`
built from the shared runtime contracts in `shared/runtime/executionTypes.ts`.

**`KernelResult` top-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| *(AgentTurnOutput fields)* | — | `message`, `artifact`, `suppressChatContent`, `outputChannel` |
| `meta` | `KernelExecutionMeta` | Execution correlation and classification metadata |
| `executionState` | `ExecutionState` | Terminal execution state using shared runtime vocabulary |

**`KernelExecutionMeta` fields use the canonical shared vocabulary:**

| Field | Type | Source |
|-------|------|--------|
| `executionId` | `string` | UUID v4, generated at intake |
| `startedAt` | `number` | Unix ms at intake |
| `executionType` | `RuntimeExecutionType` | `shared/runtime/executionTypes.ts` — currently `'chat_turn'` |
| `executionClass` | `ExecutionClass` | kernel-local — `'standard'` \| `'direct_answer'` \| `'tool_heavy'` |
| `durationMs` | `number` | Set at finalize |
| `origin` | `RuntimeExecutionOrigin` | `shared/runtime/executionTypes.ts` — resolved from `KernelRequest.origin` at intake; `IpcRouter` passes `'ipc'` |
| `mode` | `RuntimeExecutionMode` | `shared/runtime/executionTypes.ts` — resolved from `KernelRequest.executionMode` at intake; `IpcRouter` passes the active mode from settings |


### Shared Execution Contract Adoption (Phase 3)

`shared/runtime/` contains the canonical runtime execution vocabulary used across core seams.

| Seam | File | Adopted vocabulary |
|------|------|--------------------|
| Chat turn entry | `AgentKernel.ts` | `RuntimeExecutionType ('chat_turn')`, `RuntimeExecutionOrigin`, `RuntimeExecutionMode`, `ExecutionState` |
| IPC dispatch | `IpcRouter.ts` | reads `getActiveMode()` → passes `executionMode` + `origin: 'ipc'` in `KernelRequest` |
| Autonomous run | `AutonomousRun` (autonomyTypes.ts) | `executionId` (maps to `runId`), `runtimeExecutionType: 'autonomy_task'`, `runtimeExecutionOrigin: 'autonomy_engine'`; `_executeGoalPipeline` registers with `ExecutionStateStore` and emits `execution.created/accepted/finalizing/completed/failed` via `TelemetryBus` (subsystem=`'kernel'`, mode=`'system'`); `execution.finalizing` and `execution.completed` include `durationMs` |
| Reflection planning run | `PlanRun` (reflectionPlanTypes.ts) | `runtimeExecutionType: 'reflection_task'` |

All shared types are in `shared/runtime/executionTypes.ts`. Factory helpers are in `shared/runtime/executionHelpers.ts`. Both are re-exported from `shared/runtime/index.ts`.

The Phase 3 controlled-execution vocabulary in `shared/executionTypes.ts` (`ExecutionStatus`, `ExecutionRun`, etc.) is a separate, narrower contract for the patch-apply/rollback pipeline and is **not** merged with the runtime contracts above. Use `shared/runtime/executionTypes.ts` (or `shared/runtime/index.ts`) when tagging cross-seam execution identity. Use `shared/executionTypes.ts` when working with the controlled-execution patch/apply pipeline in `electron/services/execution/`.

#### Shared TelemetryBus Lifecycle Schema

Both `AgentKernel` (chat) and `AutonomousRunOrchestrator` (autonomy) emit into the same `TelemetryBus` with a unified event lifecycle. Events are indistinguishable at schema level except for `type` and `origin` in the payload.

| Event | Phase label | Payload fields | When emitted |
|---|---|---|---|
| `execution.created` | `intake` | `type`, `origin`, `mode` | Request received and ID assigned |
| `execution.accepted` | `intake` | `type`, `origin`, `mode` | Request registered and ready to begin |
| `execution.blocked` | `classify` | `type`, `origin`, `mode`, `blockedReason`, `code` | Policy denied: execution blocked at classifyExecution |
| `execution.finalizing` | `finalizing` | `type`, `origin`, `mode`, `durationMs` | Success path: entering terminal finalization |
| `execution.completed` | `finalizing` | `type`, `origin`, `mode`, `durationMs` | Success path: execution finalized cleanly |
| `execution.failed` | `failed` | `type`, `origin`, `mode`, `failureReason` | Failure path: unrecoverable error |

All events carry `executionId` (matching `runId` for autonomy, `executionId` for kernel) and `subsystem='kernel'`.

For chat turns: `type='chat_turn'`, `origin='ipc'` (or `'chat_ui'`), `mode='assistant'|'hybrid'|'rp'`.
For autonomy tasks: `type='autonomy_task'`, `origin='autonomy_engine'`, `mode='system'`.

This unified schema enables a future dashboard to consume both streams without distinguishing the source.

### PolicyGate — Runtime Enforcement Seam

`PolicyGate` (`electron/services/policy/PolicyGate.ts`) is the central cross-cutting enforcement seam.
It is stateless and deterministic: the same context always produces the same decision.
The current implementation is stub allow-all; enforcement is added by inserting real rules without
changing any call site.

#### Evaluation tiers

| Tier | Method | Context type | Where called |
|------|--------|--------------|--------------|
| Execution admission | `checkExecution(ctx)` / `evaluate()` | `ExecutionAdmissionContext` | `AgentKernel.classifyExecution()` |
| Side-effect pre-check | `checkSideEffect(ctx)` / `assertSideEffect(ctx)` | `SideEffectContext` | `AgentService` before `tools.executeTool()` |
| Side-effect pre-check | `assertSideEffect(ctx)` | `SideEffectContext` (`actionKind='workflow_action'`) | `WorkflowEngine.executeWorkflow()` — before each BFS node, with `executionMode` threaded from caller |
| Side-effect pre-check | `assertSideEffect(ctx)` | `SideEffectContext` (`actionKind='workflow_action'`) | `WorkflowRegistry.executeWorkflow()` — before each step's `toolDef.execute()`; `executionMode` defaults to `'system'` (MCP/system origin); `mutationIntent=mcp_node_execute:<tool>` |

#### `SideEffectContext` fields

| Field | Type | Description |
|-------|------|-------------|
| `actionKind` | `SideEffectActionKind` | `'tool_invoke'` \| `'memory_write'` \| `'file_write'` \| `'workflow_action'` \| `'autonomy_action'` |
| `executionId?` | `string` | Parent execution ID for telemetry correlation |
| `executionType?` | `string` | Logical type of the parent execution |
| `executionOrigin?` | `string` | Origin of the parent execution |
| `executionMode?` | `string` | Runtime mode in effect |
| `capability?` | `string` | Tool or capability name being exercised |
| `targetSubsystem?` | `string` | Subsystem that would execute the action |
| `mutationIntent?` | `string` | Human-readable description of what would be mutated |

#### Future enforcement seams (prepared, not yet enforced)

The following call sites are identified for future rule attachment; wiring them requires only adding
rules to `PolicyGate.evaluate()` — no call-site changes are needed:

- `AgentService` post-turn memory write (after tool loop, before `mem0`/Postgres write)



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
| `resolvedMemories` | `MemoryItem[]` (optional) | Approved memory items forwarded to cognitive assembly |
| `responseMode` | `ResponseMode` (optional) | Grounding mode: `memory_grounded_soft`, `memory_grounded_strict`, or `canon_required` |
| `canonGateDecision` | `object` (optional, lore turns only) | Canon gate outcome: `isAutobiographicalLoreRequest`, `sufficientCanonMemory`, `canonSourceTypes`, `canonGateApplied` |

## 3. Mode Routing and Capability Gating

Mode is enforced centrally by `TalaContextRouter.process()`, not scattered across services.

| Mode | Memory Retrieval | Memory Write | Tool Access |
|------|-----------------|--------------|-------------|
| `assistant` | Enabled (filtered by mode_scope) | short_term or long_term | All allowed |
| `rp` | Enabled for lore/RP turns; blocked for greetings | do_not_write | All blocked |
| `hybrid` | Enabled | short_term | All allowed |
| Greeting (any mode) | Suppressed | do_not_write | memory_retrieval blocked |

## 3a. Lore / Autobiographical Retrieval Policy

For `intent=lore` (autobiographical queries about Tala's past), `TalaContextRouter.process()` applies a canon-first retrieval policy:

1. **RAG/LTMF** (`RagService.searchStructured()`) — canonical lore, up to 5 results. For autobiographical age queries, Tala applies structured filters (`age`, `source_type=ltmf`, `memory_type=autobiographical`, `canon=true`) so canon retrieval does not depend on natural-language dates inside memory text.
2. **mem0 / local conversational memory** (`MemoryService.search()`) — fallback, 10 results.
3. RAG candidates are **prepended** to the candidate list before `MemoryFilter` so they enter the same deduplication and ranking pipeline.
4. `MemoryFilter.resolveContradictions()` applies lore source ranking: `diary/graph(4) > rag(3) > mem0(2) > explicit/chat(1)`, ensuring canon lore outranks recent chat snippets regardless of composite score.
5. RP mode `allowedSources` includes `'rag'` so LTMF lore items pass the source policy gate.
6. For structured autobiographical age queries only, candidates that exactly match `age + source_type=ltmf + memory_type=autobiographical + canon=true` are treated as high-confidence canon matches even when semantic similarity is below the default autobiographical threshold.
7. CanonGate uses a dynamic minimum for autobiographical age turns: if at least one resolved memory has `structured_autobio_age_match=true`, `minRequiredCanonCount=1` for that turn; otherwise it remains `2`. Non-age autobiographical lore queries always keep `minRequiredCanonCount=2`.
8. Age extraction for structured autobiographical filters is tolerant to imperfect phrasing (`your 17`, `you're 17`, `ur 17`, `when u were 17`) and may use standalone age numbers in range `8..33` when autobiographical context terms are present.
   The parser also normalizes common fused missing-space variants (for example `aboutwhen you were 17`) before autobiographical age extraction.
9. Structured autobiographical age matches also bypass the autobiographical confidence threshold (`0.65`) by being treated as confidence-qualified canon hits; non-structured canon candidates still require the standard confidence gate.
10. Degraded memory-state handling remains strict by default, but autobiographical age queries can pass in degraded mode when at least one `structured_autobio_age_match=true` canon memory is present. Without that structured canon match, degraded mode still forces `canon_required`.

### 3a-i. Canon Metadata Persistence and Legacy Backfill

`mcp-servers/tala-core/server.py` now normalizes LTMF chunk metadata through `mcp-servers/tala-core/metadata_canon.py` at three points:

1. Store load: existing `metadata.json` records are backfilled and persisted when canonical fields are missing.
2. Ingestion add: each new chunk metadata object is normalized before append/save.
3. Search filter: structured filter matching (`age`, `source_type`, `memory_type`, `canon`, `age_sequence`) uses normalized metadata with type-safe coercion.

This keeps strict autobiographical filters working for both new imports and legacy LTMF records that were ingested before canonical fields were present.

**Follow-up carryover:** If the prior turn was `intent=lore` and the current turn matches a follow-up pattern (e.g. "you don't remember?", "what about that?"), the router carries over the lore retrieval domain for up to 5 minutes.

## 3b. Memory-Grounded Response Mode

When `intent=lore` and approved lore memories are present, `TalaContextRouter.process()` activates a **memory-grounded response mode** so the model anchors its answer to the retrieved memories rather than improvising around them.

### Mode selection

| User query contains | Mode activated |
|---|---|
| Plain lore query (no precision trigger) | `memory_grounded_soft` (default) |
| "exactly", "don't make anything up", "strictly from memory", "what specifically", "what does the memory say", "quote the memory", "just what happened" | `memory_grounded_strict` |
| Autobiographical lore query with insufficient high-trust canon memory | `canon_required` (canon gate) |
| No lore memories retrieved (non-autobiographical query) | No mode activated |

The `responseMode` value is stored on `TurnContext.responseMode` for downstream audit.

### 3b-i. Canon Memory Sufficiency Gate

For queries that are specifically asking for **Tala's own lived experiences** (first-person autobiographical memory requests), the router applies a canon-memory sufficiency gate after source-bucket composition.

**Detection:** `TalaContextRouter.isAutobiographicalLoreRequest(query)` matches patterns such as:
- "something that happened to you", "what happened to you when"
- "when you were 17", "when you were young/a child"
- "at age [N]", "at [N] years old"
- "at seventeen", "during your seventeenth year"
- "your childhood", "your past", "your personal history", "growing up"
- "do you remember", "can you remember"
- "tell me about your past/childhood/memories/experience"

**Sufficiency check:** `TalaContextRouter.hasSufficientCanonMemoryForAutobio(resolved)` returns `true` only when at least **two** approved canon memories pass both quality thresholds (`semantic >= 0.55`, `confidence >= 0.65`) from high-trust sources: `diary`, `graph`, `core_bio`, `lore`, or `rag`.

Fallback sources (`mem0`, `explicit`, `conversation`) alone are **not sufficient** for first-person autobiographical fact claims.

**When the gate fires:**
- `responseMode` is forced to `'canon_required'`
- `TurnContext.canonGateDecision` is populated with `{ isAutobiographicalLoreRequest, sufficientCanonMemory, canonSourceTypes, canonGateApplied }`
- Telemetry logs: `[CanonGate] autobiographical lore request detected`, `[CanonGate] sufficientCanonMemory=false sources=... approved=N`, `[CanonGate] forcing strict no-canon response mode`, `[CanonGate] hallucination prevention active for autobiographical turn`
- `auditLogger.info('turn_routed', ...)` includes all four gate fields

### Prompt format (lore grounded turns)

`ContextAssembler.assemble()` emits blocks based on `responseMode`:

Prompt assembly behavior: if `ContextAssembler` produced `memoryContext`, `CompactPromptBuilder` carries that assembled memory block into the final system prompt across standard, compact, and compact-engineering prompt paths. Retry/tool-required branches prepend extra constraints but still send the same memory-bearing system prompt.

**`memory_grounded_soft` / `memory_grounded_strict`** (sufficient canon memory):
1. **`[AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY]`** _(structured age-matched autobiographical canon only)_ — System directive: "You must answer using the provided autobiographical memory. Do not generalize or invent."
2. **`[AUTOBIOGRAPHICAL MEMORY - AGE X]`** _(structured age-matched autobiographical canon only)_ — Prominent age-scoped autobiographical memory block placed before generic canon lore formatting.
3. **`[CANON LORE MEMORIES — HIGH PRIORITY]`** — Memories formatted with per-entry source labels:
   ```
   Memory 1:
   Source: LTMF
   Content: <memory text>
   ```
   Source label mapping: `rag` → `LTMF`, `core_bio` → `core_biographical`, `mem0` → `autobiographical`, etc.

4. **`[MEMORY GROUNDED RECALL — SOFT]`** or **`[MEMORY GROUNDED RECALL — STRICT]`** — Grounding instruction block placed immediately after the memories.

**`canon_required`** (insufficient canon memory, canon gate fired):
1. **`[FALLBACK CONTEXT — INSUFFICIENT FOR AUTOBIOGRAPHICAL CLAIMS]`** _(if fallback memories exist)_ — Any fallback memories labeled as "fallback only — insufficient for autobiographical fact claims".
2. **`[CANON GATE — NO VERIFIED AUTOBIOGRAPHICAL MEMORY]`** — Hard no-fabrication instruction. Always emitted for `canon_required` regardless of memory count. Instructs Tala to: state that no grounded memory exists, not fabricate autobiographical events, and optionally invite the user to define that canon deliberately.
3. **AgentService prompt-level override (non-RP autobiographical turns only)** — `AgentService.chat()` appends a top-level system constraint block when `responseMode='canon_required'` and `canonGateDecision.isAutobiographicalLoreRequest=true`:
   - "You MUST NOT invent, fabricate, or simulate personal memories."
   - "If you do not have verified autobiographical memory ... explicitly state that you do not have a memory."
   - "Violation of this rule is considered a system failure."
4. **Deterministic output fallback (non-RP autobiographical turns only)** — `AgentService` normalizes assistant prose to:
   - `"I don't have a recorded memory from that time."`
   This is a final-response guard against autobiographical narrative hallucination in `canon_required` mode.
5. **Authoritative finalize-stage override** — after stream/retry/timeout paths complete, `AgentService.chat()` applies a last outbound replacement before:
   - post-turn memory writes
   - artifact routing
   - chat history persistence
   - returned `AgentTurnOutput` to UI
   This guarantees user-visible and persisted response content is the fixed fallback string for eligible turns.
6. **Finalize enforcement telemetry/logging** — when replacement is applied:
   - log line includes `canon_required_fallback_enforced=true`, `originalContentLength=<n>`, `replacedAtStage=finalize`
   - telemetry event: `canon_required_fallback_enforced` with payload fields:
     - `canon_required_fallback_enforced`
     - `originalContentLength`
     - `replacedAtStage`
     - `mode`, `intent`, `turnId`

The `[FALLBACK CONTRACT]`, `[CANON LORE MEMORIES]`, and `[MEMORY GROUNDED RECALL]` blocks are **suppressed** when `canon_required` is active.

### Soft mode intent

Tala recalls like a human: partial, emotional, impressionistic, fuzzy at the edges. She must stay anchored to what is actually present in retrieved memory. She may describe feeling, impression, atmosphere, and uncertainty. She must not invent major events, people, causes, or locations not supported by the retrieved memories.

### Strict mode intent

Tala stays tightly factual. Only details supported by retrieved memories. If a detail is absent, she says she does not recall it clearly. Minimal extrapolation.

### Canon-required mode intent

Tala must not fabricate a first-person autobiographical event. Allowed responses:
- "I don't have a grounded memory from when I was 17."
- "I don't want to invent a false memory."
- "If you want, we can define that part of my canon deliberately."
- For non-RP autobiographical `canon_required` turns, runtime fallback may enforce:
  - "I don't have a recorded memory from that time."

Forbidden: inventing a specific event in first person as recalled fact (e.g., "I was 17 when I got into a minor car accident...").

**Audit log format for canon gate:**
```
[CanonGate] autobiographical lore request detected
[CanonGate] sufficientCanonMemory=false sources=explicit approved=1
[CanonGate] forcing strict no-canon response mode
[CanonGate] hallucination prevention active for autobiographical turn
[TalaRouter] CanonGate active — forcing responseMode=canon_required for autobiographical turn
```

## 3c. Tool Gatekeeper (ToolGatekeeper)

`electron/services/router/ToolGatekeeper.ts` is the deterministic tool-decision layer that runs **before** tools are sent to the model on every turn.  It replaces the previous inline `mem0_search` suppression block in `AgentService.ts` and adds runtime tool health tracking.

### Output

`ToolGatekeeper.evaluate()` produces a `ToolGateDecision`:

| Field | Type | Description |
|---|---|---|
| `allowedTools` | `string[]` | Tools that passed all rules and may be sent to the model |
| `blockedTools` | `string[]` | Tools suppressed for this turn |
| `gatingReasons` | `string[]` | Audit trail for each gate action |
| `directAnswerPreferred` | `boolean` | True when grounded context is sufficient |
| `requiresToolUse` | `boolean` | True when the intent mandates at least one tool call |

### Rule Groups

| Rule | Condition | Effect |
|---|---|---|
| **A** | `intent=lore` AND `approvedMemoryCount > 0` | `mem0_search` blocked |
| **A** | `responseMode=memory_grounded_soft` OR `memory_grounded_strict` OR `canon_required` | `mem0_search` blocked |
| **B** | Tool failure count ≥ 3 in 5-minute rolling window | Tool suppressed |
| **B** | Tool marked degraded via `markToolDegraded()` | Tool suppressed |
| **C** | Rules A fires | `directAnswerPreferred = true` |
| **D** | `intent=coding` OR `isBrowserTask` | `requiresToolUse = true` |
| **E** | `isRetry = true` | `priorBlockedTools` re-applied (no tool re-expansion) |

### Integration in AgentService

1. Gate is evaluated once per turn, after `filteredTools` is resolved and before the retry loop.
2. `gateDecision.blockedTools` is applied inside the loop to filter `toolsToSend` on every iteration.
3. Tool timeouts and degraded responses trigger `toolGatekeeper.recordToolFailure(toolName)` in the execution catch block.
4. Critical tools (`manage_goals`, `reflection_create_goal`) are exempt from degraded suppression.

### Log output

```
[ToolGatekeeper] blocked=mem0_search reasons=ruleA:mem0_search blocked — lore/memory-grounded turn (intent=lore responseMode=memory_grounded_soft approvedMemories=3) | ruleC:directAnswerPreferred=true — grounded memory context is sufficient
[ToolGatekeeper] directAnswerPreferred=true — grounded context is sufficient
[ToolGatekeeper] applied gate: removed 1 tool(s) blocked=mem0_search turn=1
```


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

## 9. Inference Path Integration (Phase 3)

All inference requests are gated through a single authoritative path:

```
AgentService.loadBrainConfig()
  → InferenceService.reconfigureRegistry(config)     [update provider registry from settings]
  → InferenceService.selectProvider(request)         [deterministic selection + fallback policy]
    → InferenceProviderRegistry.getInventory()       [read current provider state]
    → ProviderSelectionService.select()              [apply selection rules]
      → 1. request-selected provider if ready
      → 2. registry-selected provider if ready
      → 3. explicit local-first waterfall (`ollama` → `vllm` → `llamacpp` → `koboldcpp`)
      → 4. embedded waterfall (`embedded_vllm` → `embedded_llamacpp`)
      → 5. cloud provider (only after local/embedded exhaustion in `auto`, or directly in `cloud-only`)
      → 6. InferenceFailureResult if no viable provider
  → InferenceSelectionResult                         [selected provider + fallback chain]
  → configure OllamaBrain / CloudBrain              [brain wired to selected provider endpoint]
```

### Provider Detection Flow

```
InferenceService.refreshProviders()
  → InferenceProviderRegistry.refresh()
    → _runAllProbes() [all configured providers in parallel, failures isolated]
      → probeOllama()          → /api/tags
      → probeLlamaCpp()        → /health → /v1/models
      → probeEmbeddedLlamaCpp()  → fs.existsSync + /health
      → probeVllm()            → /v1/models
      → probeKoboldCpp()       → /api/v1/model
      → probeCloud()           → /v1/models
    → _applyProbeResult()      [update descriptor status, emit telemetry]
    → telemetry: provider_detected | provider_probe_failed | provider_unavailable
  → telemetry: provider_inventory_refreshed
```

### IPC Surface for Provider Selection

| Channel | Direction | Description |
|---------|-----------|-------------|
| `inference:listProviders` | renderer → main | Returns current `InferenceProviderInventory` |
| `inference:refreshProviders` | renderer → main | Runs probes and returns updated inventory |
| `inference:selectProvider` | renderer → main | Sets user-selected provider ID |
| `inference:getSelectedProvider` | renderer → main | Returns selected provider descriptor |

### Telemetry Events Added (Phase 3)

| Event | Subsystem | When |
|-------|-----------|------|
| `provider_inventory_refreshed` | `local_inference` | After all probes complete |
| `provider_detected` | `local_inference` | A provider probe succeeded |
| `provider_probe_failed` | `local_inference` | A provider probe failed or errored |
| `provider_selected` | `local_inference` | A provider was chosen by selection policy |
| `provider_fallback_applied` | `local_inference` | Fallback triggered (preferred unavailable) |
| `provider_unavailable` | `local_inference` | No viable provider found |
| `stream_opened` | `local_inference` | Inference stream started |
| `stream_completed` | `local_inference` | Inference stream completed successfully |
| `stream_aborted` | `local_inference` | Inference stream was cancelled |

## 10. Cognitive Turn Path (Phase 3A)

Phase 3A connects the cognitive model from Phases 3 and 3B to every live chat turn.

### Canonical Live Cognitive Loop

```
AgentService.chat()
  → PreInferenceContextOrchestrator.orchestrate()   [single canonical gathering call]
    → TalaContextRouter.process()                    [memory + doc retrieval, intent, mode]
    → AstroService.getEmotionalState()               [emotional state, mode-gated]
    → reflectionContributionStore.getNoteCount()     [in-process, no I/O]
    → _queryMcpPreInference()                        [intent/mode-gated, graceful no-op]
  → PreInferenceOrchestrationResult                  [normalised pre-inference packet]
  → CognitiveTurnAssembler.assemble()                [builds TalaCognitiveContext]
  → InferenceService.selectProvider()                [provider/model for this turn]
  → PromptProfileSelector.select()                   [model capability profile]
  → CognitiveContextCompactor.compact()              [CompactPromptPacket]
  → CompactPromptBuilder.build(..., compactPacket)   [final system prompt]
  → streamWithBrain()                                [canonical inference path]
  → post-turn:
      → storeMemories()                              [mem0 + RAG + memory graph]
      → ReflectionEngine.recordTurn()                [latency/outcome signal]
      → diagnosticsAggregator.recordCognitiveContext() [diagnostics snapshot]
```

### Source Gating Policy

`PreInferenceContextOrchestrator` applies intent/mode-aware gating before any retrieval call:

| Source | Queried | Suppressed |
|--------|---------|-----------|
| Memory (via TalaContextRouter) | Always | — |
| Docs (via TalaContextRouter) | doc-relevant query + mode ≠ rp | RP mode or no relevant query |
| Astro/emotion | mode ≠ rp and astro ready | RP mode or astro unavailable |
| Reflection store | Always (in-process) | — |
| MCP pre-inference | coding/technical/task intent + mode ≠ rp | Greeting, conversation, RP |

### Graceful Degradation

- Astro unavailable → `astroStateText = null`, telemetry `emotional_state_skipped`, turn continues.
- MCP pre-inference fails → `mcpContextSummary = undefined`, telemetry `mcp_preinference_failed`, turn continues.
- Compaction fails → `compactPacket = undefined`, legacy `CompactPromptBuilder` path used, warning logged.

### TurnContext.resolvedMemories (Phase 3A)

`TurnContext` now includes `resolvedMemories?: MemoryItem[]` — the de-duplicated, contradiction-resolved memories from the router retrieval pass. This feeds `CognitiveTurnAssembler.assemble()` directly without a second memory query.

### Diagnostics Integration

`AgentService.setDiagnosticsAggregator(agg)` (called by `IpcRouter.registerAll()`) wires the runtime diagnostics aggregator. After every turn, `RuntimeDiagnosticsAggregator.recordCognitiveContext(cognitiveContext)` stores the live cognitive context, making it available through `diagnostics:getRuntimeSnapshot`.

---

## Tool-Call Execution Pipeline Decision Logic

`AgentService.chat()` runs a `while` loop (max `MAX_AGENT_ITERATIONS`) to execute tool calls from the LLM response.  The following rules govern how tool calls are detected, recovered, and finalized on each iteration.

### Decision branch order

```
streamWithBrain()
  → response (BrainResponse | StreamInferenceResult)
  
  1. responseToolCalls = response.toolCalls         [canonical; may be undefined]
  
  2. Loop-detection guard
       if !responseToolCalls?.length
         && runtimeSafety.checkResponseLoop(content)
       → finalResponse = "Loop detected…"  ← ONLY fires when no tool calls present
         break
  
  3. calls = (activeMode === 'rp') ? [] : responseToolCalls
  
  4. ToolRequired recovery retry
       triggers when ALL of the following are true:
         • toolsToSend.length > 0 (tools were authorized for this turn)
         • hasKeywordIndicatingToolUse || calls.length === 0
         • calls.length === 0
         • activeMode !== 'rp'
         • turn is not a greeting
         • gateDecision.blockedTools.length === 0  ← skip if ToolGatekeeper blocked tools
         • !gateDecision.directAnswerPreferred      ← skip if grounded memory is sufficient
       • sends retryResponse with envelope prompt + filteredTools
       • populates calls from retryResponse.toolCalls
       • falls back to brace-depth JSON envelope extraction from retryResponse.content
       • if calls found: assistantMsg.content ← retryResponse.content (consistency fix)
       • if calls empty + coding intent: hard-fail ("Tool call required…")  break
       • if calls empty + other intent: fall through to plain-content path
  
  5. Plain-content finalization
       if calls.length === 0:
         finalResponse = response.content  ← ONLY reached when no canonical toolCalls
         break
  
  6. Tool execution
       for each call in calls:
         ToolService.executeTool(toolName, args, allowedToolNames)
         if result.startsWith('BROWSER_') && onEvent:
           dispatchBrowserCommand() → agent-event → workspace browser panel
         executionLog.toolCalls.push(…)
```

### Key invariants (enforced post-fix)

| Invariant | Enforcement |
|-----------|-------------|
| `finalResponse` from plain content only when canonical toolCalls are truly absent | Loop-detection guard (step 2) skips when `responseToolCalls` non-empty; plain-content path (step 5) only reached when `calls.length === 0` |
| Browser tool calls always reach `ToolService.executeTool()` | `hasKeywordIndicatingToolUse` now includes browser verbs/nouns; `toolsToSend.length > 0 && calls.length === 0` triggers recovery for any non-RP tool-available turn |
| Coding turns always hard-fail if no tool calls produced | Coding intent check in step 4 retry failure path |
| Non-coding retry failures return the original prose response | Non-coding intents fall through to step 5 after a failed retry |
| assistantMsg context is consistent with its tool_calls | When retry provides calls, assistantMsg.content is sourced from retryResponse |
| ToolRequired retry never fires when ToolGatekeeper blocked tools | `gateDecision.blockedTools.length === 0` guard in `toolRequiredEligible` |
| ToolRequired retry never fires when memory grounding is sufficient | `!gateDecision.directAnswerPreferred` guard in `toolRequiredEligible` |

### hasKeywordIndicatingToolUse patterns

The keyword check (step 4) fires on two sets of patterns ANDed together:

- **File-system verbs** (`create`, `write`, `edit`, …) × **file nouns** (`file`, `script`, `.ts`, `.json`, …)
- **Browser verbs** (`browse`, `navigate`, `open`, `search`, `click`, `scroll`, `go`, …) × **web nouns** (`url`, `page`, `browser`, `site`, `https`, …) or HTTP URL pattern

---

### Phase 3A Telemetry Events

All Phase 3A events are emitted in the `cognitive` subsystem:

| Event | When |
|-------|------|
| `preinference_orchestration_started` | Orchestration begins |
| `preinference_orchestration_completed` | Orchestration succeeded |
| `preinference_orchestration_failed` | Orchestration threw |
| `mcp_preinference_requested/completed/suppressed/failed` | MCP gating/result |
| `memory_preinference_applied` | Memory result applied or suppressed |
| `doc_preinference_applied` | Doc context applied or suppressed |
| `emotional_state_requested/applied/skipped` | Astro state gating/result |
| `reflection_note_applied/suppressed` | Reflection store check |
| `live_cognitive_context_recorded` | Diagnostics updated |
| `live_compaction_applied` | CompactPromptPacket produced on real turn |
| `post_turn_memory_write` | Mem0 post-turn write confirmed |
| `post_turn_reflection_signal` | ReflectionEngine.recordTurn() called |

---

## 9. Autonomous Self-Improvement Pipeline (Phases 4–5.1)

The autonomous improvement pipeline runs in `AutonomousRunOrchestrator` as a background cycle. It is separate from the user turn loop.

```
AutonomousRunOrchestrator.runCycleOnce()
  → GoalDetectionEngine.runOnce()         (Phase 4.1/4.2 — detect candidates)
  → GoalPrioritizationEngine.score()      (Phase 4C — score and tier goals)
  → AutonomyPolicyGate.evaluate()         (Phase 4D — required gate)
    → [blocked → policy_blocked goal]
    → [permitted → continue]
  → [Phase 5 Adaptive Layer — optional]
    → GoalValueScoringEngine.score()      (P5B)
    → StrategySelectionEngine.select()    (P5C)
    → AdaptivePolicyGate.evaluate()       (P5D)
      → defer/suppress/escalate → update goal status, return
      → proceed → continue
  → [Phase 5.1 Escalation Layer — optional]
    → ModelCapabilityEvaluator.evaluate() (P5.1B — can model handle this?)
      → canHandle=true → continue
      → canHandle=false:
          EscalationPolicyEngine.evaluate()  (P5.1C — is escalation allowed?)
          DecompositionEngine.decompose()    (P5.1D — bounded decomposition plan)
          ExecutionStrategySelector.select() (P5.1E — which strategy?)
          → proceed_local   → continue
          → escalate_human  → policy_blocked + humanReviewRequired=true
          → escalate_remote → policy_blocked + humanReviewRequired=true (default)
          → decompose_local → _executeGoalPipeline with scopeHint from first step
          → defer           → goal reset to scored (next cycle)
  → _executeGoalPipeline()
      → set run.executionId = run.runId (canonical cross-seam identifier)
      → ExecutionStateStore.beginExecution() (registers run as 'accepted' autonomy_task)
      → TelemetryBus.emit(execution.created, execution.accepted)
      → SafeChangePlanner.plan()           (Phase 2)
      → GovernanceAppService.evaluate()    (Phase 3.5)
      → ExecutionOrchestrator.start()      (Phase 3)
      finally:
        → compute durationMs = Date.now() - startedAtMs
        on success:
          → ExecutionStateStore.advancePhase('finalizing')
          → TelemetryBus.emit(execution.finalizing)  (executionId=runId, durationMs)
          → TelemetryBus.emit(execution.completed)   (executionId=runId, durationMs)
          → ExecutionStateStore.completeExecution()
        on failure:
          → TelemetryBus.emit(execution.failed)      (executionId=runId, failureReason)
          → ExecutionStateStore.failExecution()
        → OutcomeLearningRegistry.record()           (Phase 4)
        → RecoveryPackOutcomeTracker.record()        (Phase 4.3 — when pack used)
        → SubsystemProfileRegistry.update()          (Phase 5 feedback)
        → DecompositionOutcomeTracker.finalizePlan() (Phase 5.1 — when decomposing)
        → EscalationAuditTracker.record()            (Phase 5.1 audit trail)
```

### Phase 5.1 Integration Notes

- **Placement**: After Phase 5 adaptive gate `proceed`, before `_executeGoalPipeline`. Never runs when Phase 5 defers/suppresses/escalates.
- **Error isolation**: Exceptions in the Phase 5.1 layer are caught and logged. Pipeline falls back to standard execution.
- **Scope narrowing**: When `decompose_local` is selected, `_buildPlanInput()` receives a `decompositionScopeHint` (first step's `scopeHint`) that narrows the planning description.
- **Feedback loop**: `DecompositionOutcomeTracker.finalizePlan()` runs in the finally block, applying per-subsystem cooldown after full decomposition failure.
- **Audit trail**: `EscalationAuditTracker` records every assessment, escalation request/decision, strategy selection, and decomposition event.

See `docs/architecture/phase5_1_escalation_decomposition.md` for the full Phase 5.1 architecture reference.



