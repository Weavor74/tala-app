# Phase 3C: Cognitive Behavior Validation and Small-Model Tuning

## Overview

Phase 3C validates and tunes the live cognitive system assembled in Phases 3A and 3B.
It does not introduce new architectural components — it confirms that the full cognitive
loop behaves correctly across model sizes, validates retrieval policies, tunes emotional
modulation bounds, tightens reflection noise control, and extends the runtime diagnostics
panel with cognitive observability.

The phase concludes with 8 new validation test suites covering every major subsystem of
the cognitive loop, confirmed passing at 694 total tests across 48 test files.

---

## What Phase 3C Validates

### 1. Small-Model Prompt Validation

`CognitiveContextCompactor` is confirmed to enforce budget caps for tiny (3B-class) and
small (7B-class) models:

- `tiny_profile`: aggressive compaction, identity cap=2, task cap=3, continuity cap=2,
  preference cap=0, no full tool schemas, no full identity prose.
- Prompt overflow is prevented by dropping lower-priority memory and doc contributions
  before identity or mode blocks.
- `CompactionDiagnosticsSummary` tracks `memoriesKept`, `memoriesDropped`,
  `docsIncluded`, `reflectionNotesKept`, and `sectionsDropped` for every compaction.

Approximate token allocation for a tiny profile turn:

```
Profile: tiny_profile
Identity: compressed scaffold (~70 tokens)
Task: up to 3 task_relevant memories (~110 tokens)
Memory: up to 2 identity + 2 continuity contributions (~100 tokens)
Docs: suppressed unless highly relevant (~60 tokens when included)
Emotion: compressed bias (~25 tokens)
Tools: none (toolDescriptionCap=0 for tiny) (~35 tokens for policy text only)
Rules: concise response rules (~30 tokens)
```

### 2. Memory Retrieval Validation

`MemoryContributionBuilder` is confirmed to:

- Classify memories by category (`identity`, `task_relevant`, `preference`, `recent_continuity`)
  using metadata type/role/tags, with explicit annotation taking precedence.
- Suppress all retrieval for greeting turns (`retrievalSuppressed=true`).
- Cap contributions per category: identity≤3, task_relevant≤5, preference≤3, continuity≤3.
- Record `candidateCount` and `excludedCount` accurately for diagnostics.
- Produce non-empty summaries (≤200 chars) and rationale for each contribution.
- Assign valid salience scores in [0, 1] to every contribution.

### 3. Doc Retrieval Validation

`ModePolicyEngine.getCognitiveRules()` is confirmed to return:

- `docRetrievalPolicy: 'enabled'` for `assistant` and `hybrid` modes.
- `docRetrievalPolicy: 'suppressed'` for `rp` mode.

`DocContributionModel` carries a compacted summary (not raw chunk content), a rationale
for both applied and suppressed states, and a valid ISO `retrievedAt` timestamp.

### 4. MCP Pre-Inference Validation

`PreInferenceContextOrchestrator._isMcpPreInferenceEligible()` is confirmed to gate
MCP pre-inference queries as follows:

| Mode | Intent | MCP Eligible |
|------|--------|-------------|
| rp | any | No |
| assistant | greeting / conversation | No |
| assistant | coding / technical / task | Yes |
| hybrid | coding / technical / task | Yes |
| any | unknown / empty | No |

MCP failures are handled gracefully — a failed or timed-out MCP call produces
`undefined` summary and does not prevent turn completion. Telemetry is emitted
for gating decisions, requests, completions, and failures.

### 5. Emotional Modulation Tuning

`EmotionalModulationPolicy.apply()` is confirmed to:

- Return `applied=false, strength='none', astroUnavailable=true` when astro state is
  null, empty, or whitespace.
- Return `applied=false` when the emotional vector magnitude is below 0.15 threshold
  (all dimensions near neutral 0.5).
- Cap modulation at `'medium'` for `assistant` and `hybrid` modes.
- Allow `'capped'` modulation for `rp` mode with high-magnitude vectors.
- Apply model-size cap: `tiny` and `small` receive at most `'medium'`.
- `medium` and `large` models receive up to `'capped'` in RP mode.

The `modulation_summary` and `influencedDimensions` fields are populated whenever
`applied=true`, providing safe, prompt-injectable bias text.

### 6. Reflection Noise Control

`ReflectionContributionStore` is confirmed to:

- Suppress notes with confidence < 0.4 at creation time (`suppressed=true`).
- Truncate note summaries to 300 characters.
- Expire notes that exceed their lifespan (`expiresAt` check on each `buildContributionModel` call).
- Exhaust notes after `maxApplications` uses (incrementing `applicationCount` on each call).
- Return `applied=false` when only suppressed or expired notes are present.
- Track suppressed notes separately in `suppressedNotes` array for diagnostics.

Default lifespans by note class:
- `caution_note`: 30 min
- `failure_pattern_note`: 1 hour
- `stability_note`: 20 min
- `preference_reminder`: 4 hours
- `continuity_reminder`: 15 min

Reflection notes remain rare but meaningful: only high-confidence, non-expired, non-exhausted
notes appear in `activeNotes` and influence behavior.

### 7. Cross-Model Consistency

`ModelCapabilityClassifier` and `CognitiveContextCompactor` produce consistent behavior
across model sizes:

| Model | Class | Profile | Compaction |
|-------|-------|---------|-----------|
| qwen2.5:3b | tiny | tiny_profile | aggressive |
| llama3.1:7b | small | small_profile | moderate |
| llama2:13b | medium | medium_profile | standard |
| llama3.1:70b | large | large_profile | full |

Consistent across all models:
- Non-empty identity core
- Mode block containing active mode name
- Diagnostics summary with parameterClass populated

Intentional differences:
- Large models allow full tool schemas (`allowFullToolSchemas=true`); tiny does not.
- Large models allow full identity prose (`allowFullIdentityProse=true`); tiny does not.
- Total memory budget increases with model size (tiny=7, large=21).

### 8. Diagnostics Panel Extensions

`RuntimeDiagnosticsAggregator` is extended with Phase 3C cognitive fields:

- `recordCognitiveContext(context)`: stores the last `TalaCognitiveContext` per turn.
- `recordCognitiveMeta(meta)`: stores compaction summary, performance timings, and
  per-source counts (docs retrieved/used/compacted, MCP services queried/used/failed).
- `_buildCognitiveDiagnostics()`: assembles `CognitiveDiagnosticsSnapshot` from the
  recorded context and meta.

Example diagnostics snapshot:

```
Prompt Profile:    tiny_profile
Memories Used:     3 (identity=1, task_relevant=2)
Docs Used:         1
MCP Sources:       astro (suppressed=0, used=1)
Emotion Bias:      warmth +0.2 (strength=low)
Reflection Notes:  none active
Compaction Drops:  2 memories dropped, 0 sections dropped
```

---

## Files Verified

### Cognitive Services (existing, validated in Phase 3C)

- `electron/services/cognitive/PreInferenceContextOrchestrator.ts` — MCP gating confirmed
- `electron/services/cognitive/CognitiveContextCompactor.ts` — budget enforcement confirmed
- `electron/services/cognitive/MemoryContributionModel.ts` — ranking and categorization confirmed
- `electron/services/cognitive/EmotionalModulationPolicy.ts` — strength caps confirmed
- `electron/services/cognitive/ReflectionContributionModel.ts` — noise control confirmed
- `electron/services/cognitive/ModelCapabilityClassifier.ts` — cross-model classification confirmed
- `electron/services/cognitive/CognitiveBudgetApplier.ts` — budget application confirmed

### Router / Agent

- `electron/services/router/TalaContextRouter.ts` — doc/memory routing unchanged, confirmed
- `electron/services/router/ModePolicyEngine.ts` — `getCognitiveRules()` returns correct policies

### Diagnostics

- `electron/services/RuntimeDiagnosticsAggregator.ts` — Phase 3C cognitive fields confirmed
- `electron/services/AgentService.ts` — orchestration path unchanged

### Prompt Assembly

- `electron/services/plan/CompactPromptBuilder.ts` — receives `CompactPromptPacket`

### Shared Types

- `shared/modelCapabilityTypes.ts` — `CompactPromptPacket`, `CompactionDiagnosticsSummary`
- `shared/cognitiveTurnTypes.ts` — `TalaCognitiveContext`, `CognitiveDiagnosticsSnapshot`

---

## Tests Added

| File | Test Count | Coverage Area |
|------|-----------|---------------|
| `tests/TinyModelPromptValidation.test.ts` | 14 | Tiny model classification, budget enforcement, compaction |
| `tests/MemoryRankingValidation.test.ts` | 12 | Memory categorization, salience, caps, suppression |
| `tests/DocRetrievalValidation.test.ts` | 10 | Doc retrieval gating, DocContributionModel |
| `tests/McpGatingValidation.test.ts` | 12 | MCP eligibility rules, graceful degradation |
| `tests/EmotionalModulationValidation.test.ts` | 15 | Modulation strength, mode/model caps |
| `tests/ReflectionNoiseControl.test.ts` | 14 | Note suppression, expiry, exhaustion |
| `tests/CrossModelConsistency.test.ts` | 14 | Cross-model classification and compaction |
| `tests/CognitiveDiagnosticsSnapshot.test.ts` | 10 | Snapshot structure, aggregator recording |

**Total Phase 3C tests added: 101**
**Total repository tests: 694 (48 test files)**

---

## Performance Targets

Phase 3C confirms the pre-inference overhead target:

| Stage | Target | Notes |
|-------|--------|-------|
| Pre-inference orchestration | < 40 ms | Memory + doc + astro in parallel |
| Cognitive assembly | < 10 ms | Pure in-memory operation |
| Compaction | < 5 ms | Deterministic budget application |
| **Total cognitive overhead** | **< 55 ms** | Under 40 ms target for orchestration alone |

MCP pre-inference is gated and only runs for technical/coding/task intents in
assistant/hybrid mode, preventing unnecessary latency on conversational turns.

---

## Operational Behavior After Phase 3C

The cognitive loop is stable across all supported model sizes. The system degrades
gracefully when sources are unavailable:

- Astro unavailable → `applied=false, astroUnavailable=true`, no error
- MCP failure → `mcpContextSummary=undefined`, turn continues
- Memory empty → `retrievalSuppressed=false`, empty contributions, turn continues
- Doc not found → `applied=false`, rationale recorded, turn continues

All degradation paths produce structured diagnostics output that is visible in the
runtime diagnostics panel.
