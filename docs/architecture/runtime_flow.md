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
| `rp` | Enabled for lore/RP turns; blocked for greetings | do_not_write | All blocked |
| `hybrid` | Enabled | short_term | All allowed |
| Greeting (any mode) | Suppressed | do_not_write | memory_retrieval blocked |

## 3a. Lore / Autobiographical Retrieval Policy

For `intent=lore` (autobiographical queries about Tala's past), `TalaContextRouter.process()` applies a canon-first retrieval policy:

1. **RAG/LTMF** (`RagService.searchStructured()`, filter `category=roleplay`) — canonical lore, up to 5 results. Converted to `MemoryItem` with `source=rag`, `role=rp`, `type=lore`.
2. **mem0 / local conversational memory** (`MemoryService.search()`) — fallback, 10 results.
3. RAG candidates are **prepended** to the candidate list before `MemoryFilter` so they enter the same deduplication and ranking pipeline.
4. `MemoryFilter.resolveContradictions()` applies lore source ranking: `diary/graph(4) > rag(3) > mem0(2) > explicit/chat(1)`, ensuring canon lore outranks recent chat snippets regardless of composite score.
5. RP mode `allowedSources` includes `'rag'` so LTMF lore items pass the source policy gate.

**Follow-up carryover:** If the prior turn was `intent=lore` and the current turn matches a follow-up pattern (e.g. "you don't remember?", "what about that?"), the router carries over the lore retrieval domain for up to 5 minutes.

## 3b. Memory-Grounded Response Mode

When `intent=lore` and approved lore memories are present, `TalaContextRouter.process()` activates a **memory-grounded response mode** so the model anchors its answer to the retrieved memories rather than improvising around them.

### Mode selection

| User query contains | Mode activated |
|---|---|
| Plain lore query (no precision trigger) | `memory_grounded_soft` (default) |
| "exactly", "don't make anything up", "strictly from memory", "what specifically", "what does the memory say", "quote the memory", "just what happened" | `memory_grounded_strict` |
| No lore memories retrieved | No mode activated |

The `responseMode` value is stored on `TurnContext.responseMode` for downstream audit.

### Prompt format (lore grounded turns)

`ContextAssembler.assemble()` emits two additional blocks for grounded lore turns (replacing the standard `[MEMORY CONTEXT]` block):

1. **`[CANON LORE MEMORIES — HIGH PRIORITY]`** — Memories formatted with per-entry source labels:
   ```
   Memory 1:
   Source: LTMF
   Content: <memory text>
   ```
   Source label mapping: `rag` → `LTMF`, `core_bio` → `core_biographical`, `mem0` → `autobiographical`, etc.

2. **`[MEMORY GROUNDED RECALL — SOFT]`** or **`[MEMORY GROUNDED RECALL — STRICT]`** — Grounding instruction block placed immediately after the memories.

### Soft mode intent

Tala recalls like a human: partial, emotional, impressionistic, fuzzy at the edges. She must stay anchored to what is actually present in retrieved memory. She may describe feeling, impression, atmosphere, and uncertainty. She must not invent major events, people, causes, or locations not supported by the retrieved memories.

### Strict mode intent

Tala stays tightly factual. Only details supported by retrieved memories. If a detail is absent, she says she does not recall it clearly. Minimal extrapolation.

**MemoryAudit log format for RAG candidates:**
```
[MemoryAudit] source=rag role=rp id=rag-lore-0-<ts> score=0.850 docId=ltmf-a00-0001.md
[TalaRouter] Candidates before filter — rag:3, mem0:7 (total=10)
[TalaRouter] Approved memories — rag:2, mem0:1 (total=3)
[TalaRouter] Memory-grounded response mode: memory_grounded_soft
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
      → 1. user-selected provider if ready
      → 2. best available local provider (by priority)
      → 3. embedded llama.cpp
      → 4. cloud provider
      → 5. InferenceFailureResult if no viable provider
  → InferenceSelectionResult                         [selected provider + fallback chain]
  → configure OllamaBrain / CloudBrain               [brain wired to selected provider endpoint]
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
       triggers when: hasKeywordIndicatingToolUse || (toolsToSend.length > 0 && calls.length === 0)
       AND:           calls.length === 0 && activeMode !== 'rp'
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
      → SafeChangePlanner.plan()           (Phase 2)
      → GovernanceAppService.evaluate()    (Phase 3.5)
      → ExecutionOrchestrator.start()      (Phase 3)
      finally:
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
