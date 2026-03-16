# Phase 3A: Live Cognitive Path Integration + Pre-Inference MCP Orchestration

## Overview

Phase 3A connects Tala's cognitive architecture to the live chat path, making pre-inference orchestration a first-class part of every real turn.

Before Phase 3A, cognitive assembly (Phases 3 and 3B) only ran in tests. In production, `AgentService.chat()` scattered retrieval across ad hoc calls to `getAstroState()`, `talaRouter.process()`, and raw memory/doc fragments. After Phase 3A, every real turn follows one canonical cognitive loop.

## Live Turn Order (After Phase 3A)

```
user input
→ intent / mode routing (DeterministicIntentRouter fast path or full path)
→ PreInferenceContextOrchestrator.orchestrate()
    → TalaContextRouter.process()    — memory + doc retrieval
    → AstroService.getEmotionalState() — emotional state (mode-gated)
    → reflectionContributionStore    — reflection note count
    → MCP pre-inference query        — intent/mode-gated, gracefully degraded
→ CognitiveTurnAssembler.assemble()  — builds TalaCognitiveContext
→ InferenceService.selectProvider()  — provider/model selection
→ PromptProfileSelector.select()     — model capability profile
→ CognitiveContextCompactor.compact() — CompactPromptPacket
→ CompactPromptBuilder.build()        — final system prompt
→ inference (streaming or non-streaming)
→ response
→ post-turn loop:
    → memory write (mem0 + RAG + memory graph)
    → ReflectionEngine.recordTurn()    — latency/outcome signal
    → RuntimeDiagnosticsAggregator.recordCognitiveContext() — diagnostics
```

## New Service: PreInferenceContextOrchestrator

**Location:** `electron/services/cognitive/PreInferenceContextOrchestrator.ts`

### Responsibilities

Gathers and normalises all live pre-inference context from relevant sources before `CognitiveTurnAssembler.assemble()` is called. Returns a single `PreInferenceOrchestrationResult` that carries:

- `turnContext` — the full `TurnContext` from `TalaContextRouter` (capability resolution, write policy, prompt blocks)
- `approvedMemories: MemoryItem[]` — resolved memories for cognitive assembly
- `memoryCandidateCount / memoryExcludedCount / memoryRetrievalSuppressed` — retrieval stats
- `intentClass / isGreeting` — intent classification from the router
- `memoryContextText` — pre-assembled prompt blocks (backward compatibility)
- `docContextText / docSourceIds / docRationale` — doc context extracted from router
- `astroStateText` — emotional state string or null (mode-gated, gracefully degraded)
- `mcpContextSummary` — optional MCP pre-inference summary (intent/mode-gated)
- `sourcesQueried / sourcesSuppressed` — audit metadata
- `orchestrationDurationMs` — latency

### Source Gating Rules

| Source | Queried when | Suppressed when |
|--------|-------------|-----------------|
| memory (via router) | always | — |
| doc (via router) | doc-relevant query + mode ≠ rp | rp mode or no relevant query |
| astro/emotion | astro ready + mode ≠ rp | rp mode or astro unavailable |
| reflection store | always (in-process, no I/O) | — |
| MCP pre-inference | intent ∈ {coding, technical, task} + mode ≠ rp | greeting, conversation, rp mode, no MCP |

### Graceful Degradation

- **Astro failure**: Turn continues with `astroStateText = null`. Telemetry `emotional_state_skipped` emitted.
- **MCP failure**: Turn continues with `mcpContextSummary = undefined`. Telemetry `mcp_preinference_failed` emitted.
- **Router failure**: Propagated — the turn itself requires routing.

## TurnContext Extension: resolvedMemories

`TurnContext` (in `electron/services/router/ContextAssembler.ts`) now carries an optional `resolvedMemories?: MemoryItem[]` field.

`TalaContextRouter.process()` populates this with the de-duplicated, contradiction-resolved memories that passed `MemoryFilter`. The orchestrator reads this field to feed `CognitiveTurnAssembler.assemble()` directly without a second memory query.

## AgentService Integration Points

### Pre-inference (in `AgentService.chat()`)

**Replaced:**
```typescript
// OLD — scattered, ad hoc
const astroState = await this.getAstroState(settings);
const turnObject = await this.talaRouter.process(turnId, userMessage, mode, this.docIntel);
const memoryContext = turnObject.promptBlocks.map(...).join('\n\n');
```

**With:**
```typescript
// NEW — canonical orchestration
const orchResult = await this.preInferenceOrchestrator.orchestrate(turnId, userMessage, mode, { agentId, userId });
const turnObject = orchResult.turnContext;
const memoryContext = orchResult.memoryContextText;
const astroState = orchResult.astroStateText ?? '[ASTRO STATE]: Offline';

// Cognitive assembly
const cognitiveContext = CognitiveTurnAssembler.assemble({ ...orchResult });

// Model-aware compaction
const capabilityProfile = promptProfileSelector.select(selectedProvider, modelName, turnId, activeMode);
const compactPacket = cognitiveContextCompactor.compact(cognitiveContext, capabilityProfile);

// Prompt building uses CompactPromptPacket when available
const systemPrompt = CompactPromptBuilder.build({ ..., compactPacket });
```

### Post-turn

1. **Memory writes** — unchanged fire-and-forget path; now emit `post_turn_memory_write` telemetry.
2. **Reflection signal** — `ReflectionEngine.recordTurn()` called after every turn with latency, model, token usage, and tool call stats.
3. **Diagnostics** — `this.diagnosticsAggregator?.recordCognitiveContext(cognitiveContext)` stores the authoritative cognitive context for IPC/UI inspection.

## Diagnostics Aggregator Wiring

`AgentService` now exposes `setDiagnosticsAggregator(agg: RuntimeDiagnosticsAggregator): void`.

`IpcRouter.registerAll()` calls this immediately after construction:
```typescript
agent.setDiagnosticsAggregator(this.ctx.diagnosticsAggregator);
```

This lets `RuntimeDiagnosticsAggregator.recordCognitiveContext()` store the live cognitive context for every turn, making it visible through `diagnostics:getRuntimeSnapshot`.

## CompactPromptBuilder Integration

`CompactPromptBuilder` now accepts an optional `compactPacket?: CompactPromptPacket` in `PromptContext`.

**When present (Phase 3A path):**
- Standard turns: `emotionalBiasBlock` replaces `dynamicContext`; `continuityBlock + currentTaskBlock` replace `memoryContext`.
- Engineering/compact turns: `assembledSections` from the packet replace the entire context body.

**When absent (legacy path):** Behavior is unchanged — raw `dynamicContext` and `memoryContext` are used.

## Phase 3A Telemetry Events

28 new events added to `shared/telemetry.ts`:

| Event | Description |
|-------|-------------|
| `preinference_orchestration_started` | Orchestration begins |
| `preinference_orchestration_completed` | Orchestration succeeded with source summary |
| `preinference_orchestration_failed` | Orchestration threw (turn propagates error) |
| `mcp_preinference_requested` | MCP query eligible and triggered |
| `mcp_preinference_completed` | MCP query returned |
| `mcp_preinference_suppressed` | MCP gated by mode/intent |
| `mcp_preinference_failed` | MCP query failed (graceful fallback) |
| `memory_preinference_applied` | Memory retrieval result recorded |
| `doc_preinference_applied` | Doc context extracted or suppressed |
| `emotional_state_requested` | Astro query triggered |
| `emotional_state_applied` | Astro state retrieved |
| `emotional_state_skipped` | Astro suppressed or failed |
| `reflection_note_applied` | Reflection store had active notes |
| `reflection_note_suppressed` | Reflection store empty |
| `live_cognitive_context_recorded` | Diagnostics aggregator updated |
| `live_compaction_applied` | CompactPromptPacket produced on real turn |
| `post_turn_memory_write` | Mem0 write confirmed |
| `post_turn_reflection_signal` | ReflectionEngine.recordTurn() called |

## Tests Added

**`electron/__tests__/cognitive/PreInferenceContextOrchestrator.test.ts`** — 22 tests covering:

1. Basic orchestration output shape and fields
2. Memory retrieval suppression for greetings
3. Emotional state retrieval in assistant mode
4. Emotional state suppression in RP mode
5. Graceful fallback when astro fails
6. Null astro service handling
7. MCP suppression for greetings and RP mode
8. MCP failure does not collapse the turn
9. Source tracking (sourcesQueried / sourcesSuppressed)
10. Telemetry events (started, completed, memory applied, emotional applied/skipped)
11. CognitiveTurnAssembler integration with orchestration result
12. Greeting turns produce suppressed memory context
13. PromptProfileSelector + CognitiveContextCompactor live path (tiny, medium, small models)

## Known Limitations

- **MCP pre-inference queries** are currently no-ops (`_queryMcpPreInference` returns `undefined`). The gating logic is in place; actual MCP tool queries can be added when specific cognitive state tools (e.g. astro MCP, memory graph diagnostic) are wired.
- **RAG/doc retrieval** is handled through `TalaContextRouter`, which calls `DocumentationIntelligenceService.getRelevantContext()`. Full vector-DB-backed RAG retrieval goes through this same path. The orchestrator exposes `docContextText` from the router result.
- **`getAstroState()` in AgentService** is no longer called from `chat()` but remains available for other callers (e.g. `getEmotionalStateSummary()`).

## Files Changed

| File | Change |
|------|--------|
| `shared/telemetry.ts` | 28 new Phase 3A event type literals added |
| `electron/services/cognitive/PreInferenceContextOrchestrator.ts` | **New** — canonical pre-inference orchestration service |
| `electron/services/router/ContextAssembler.ts` | Added `resolvedMemories?: MemoryItem[]` to `TurnContext` |
| `electron/services/router/TalaContextRouter.ts` | Populates `resolvedMemories` on every `TurnContext` |
| `electron/services/plan/CompactPromptBuilder.ts` | `PromptContext.compactPacket?` support; new `buildCognitiveEngineeringPrompt()` |
| `electron/services/AgentService.ts` | Wired orchestrator, assembler, compactor, diagnostics, post-turn signals |
| `electron/services/IpcRouter.ts` | Calls `agent.setDiagnosticsAggregator()` on `registerAll()` |
| `electron/__tests__/cognitive/PreInferenceContextOrchestrator.test.ts` | **New** — 22 Phase 3A tests |
