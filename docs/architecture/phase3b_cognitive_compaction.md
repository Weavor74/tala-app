# Phase 3B: Small-Model Cognitive Compaction

## Overview

Phase 3B introduces a model-aware cognitive compaction and prompt profile system that allows Tala to run coherently on 3B-class local models without losing her recognizable identity, tool-awareness, emotional modulation, or task continuity.

The system sits between `TalaCognitiveContext` (assembled by `CognitiveTurnAssembler`) and the final prompt/context assembly. It classifies the selected provider/model, selects an appropriate prompt profile, and compacts the full cognitive context into a model-appropriate packet.

## Architecture

```
TalaCognitiveContext
        │
        ▼
PromptProfileSelector  ──→  ModelCapabilityProfile
        │                        │
        │                 CognitiveBudgetProfile
        │
        ▼
CognitiveContextCompactor
        │
        ├── IdentityCompressionPolicy
        ├── ToolCompressionPolicy
        ├── EmotionalCompressionPolicy
        └── CognitiveBudgetApplier
        │
        ▼
CompactPromptPacket
(→ downstream prompt assembly)
```

## Model Classification

`ModelCapabilityClassifier` classifies provider/model combinations into four parameter classes:

| Class | Size | Profile | Compaction |
|-------|------|---------|-----------|
| tiny | ≤ 4B | tiny_profile | aggressive |
| small | 4–8B | small_profile | moderate |
| medium | 8–20B | medium_profile | standard |
| large | > 20B | large_profile | full |
| unknown | unknown | small_profile (fallback) | moderate |

**Classification strategy:**
1. Extract numeric parameter count from model name (e.g. `qwen2.5:3b` → 3B).
2. Map to parameter class using the table above.
3. If no count found, apply provider-based heuristics (cloud → large, embedded_llamacpp → small).
4. If still indeterminate, use `unknown` class with conservative fallback.

## Cognitive Budget Profiles

Each profile class has per-category caps that govern how much cognitive material is included:

| Budget field | tiny | small | medium | large |
|---|---|---|---|---|
| identityMemoryCap | 2 | 3 | 4 | 5 |
| taskMemoryCap | 3 | 4 | 6 | 8 |
| continuityMemoryCap | 2 | 3 | 4 | 5 |
| preferenceMemoryCap | 0 | 1 | 2 | 3 |
| docChunkCap | 1 | 1 | 2 | 3 |
| reflectionNoteCap | 1 | 2 | 3 | 4 |
| allowFullToolSchemas | false | false | false | true |
| allowFullIdentityProse | false | false | true | true |
| suppressDocsUnlessHighlyRelevant | true | true | false | false |
| allowRawAstroData | false | false | false | false |

Note: `allowRawAstroData` is `false` at all profile levels. Raw astro data is never injected into prompts regardless of model size.

## Compaction Precedence

The `CognitiveContextCompactor` applies compaction in this priority order (highest to lowest):

1. Identity core (always preserved)
2. Active mode (always preserved)
3. Current task intent (always preserved)
4. Tool availability/policy
5. Compressed emotional modulation
6. Top memory/context items (category-capped)
7. Response rules

Lower-priority material is dropped under budget pressure. Every compaction decision is recorded in `CompactionDiagnosticsSummary`.

## Prompt Packet Format

The `CompactPromptPacket` has a normalized, stable section order:

```
[identity]  →  Identity core block
[mode]      →  Active mode block
[emotion]   →  Compressed emotional bias block
[tools]     →  Tool policy block
[continuity] → Context/memory block
[task]      →  Current task + reflection notes
[rules]     →  Response rules
```

Empty sections are omitted. Order is deterministic across turns.

## Identity Compression

`IdentityCompressionPolicy` produces two formats:

- **Compressed scaffold** (tiny/small): bracket-label format (`[Identity]`, `[Tone]`, `[Priorities]`, etc.). Stable across turns. No long persona prose.
- **Full prose** (medium/large): flowing prose with richer nuance and mode addendum.

Core identity (role, tone, priorities, boundaries, continuity rule) is **mode-independent** and never mutated. Mode context is appended as a bounded addendum.

## Tool Compression

`ToolCompressionPolicy` produces two formats:

- **Compact policy** (tiny/small): concise one-line `[Tools]` guidance. No tool names, no schemas.
- **With tool listing** (medium/large): includes available tool names up to `toolDescriptionCap`. Full schemas only at `large_profile`.

When `toolUsePolicy = 'none'`, all profiles receive a "tools blocked" notice.

## Emotional Compression

`EmotionalCompressionPolicy` converts `EmotionalModulationInput` into `CompressedEmotionalBias`:

- `warmth`, `caution`, `confidence`, `energy` — bias tiers (`low | neutral | high`)
- `expressionShift` — bounded prose (trimmed to first sentence for tiny/small)

Raw astro data, planetary tables, and natal/transit information are **never** included at any profile level. The policy degrades gracefully when astro is unavailable.

## Memory / Doc / Reflection Budgeting

`CognitiveBudgetApplier` applies category-aware truncation:

**Memory:** Processes categories in priority order: identity → task_relevant → recent_continuity → preference. Within each category, sorts by salience descending (highest-value items kept).

**Docs:** Included only when `applied=true`, `docChunkCap > 0`, and relevance conditions are met. Suppressed entirely when `suppressDocsUnlessHighlyRelevant=true` and no high-relevance sources exist.

**Reflection:** Active notes sorted by confidence descending. Low-confidence notes and suppressed notes are dropped first.

## Telemetry

Phase 3B adds these telemetry events:

| Event | Emitter | When |
|---|---|---|
| `prompt_profile_selected` | PromptProfileSelector | On every profile selection |
| `cognitive_context_compacted_for_model` | CognitiveContextCompactor | After full compaction |
| `identity_compression_applied` | CognitiveContextCompactor | After identity compression |
| `tool_compression_applied` | CognitiveContextCompactor | After tool compression |
| `emotional_compression_applied` | CognitiveContextCompactor | After emotional compression |
| `memory_budget_applied` | CognitiveContextCompactor | After memory budget |
| `doc_budget_applied` | CognitiveContextCompactor | After doc budget |
| `reflection_budget_applied` | CognitiveContextCompactor | After reflection budget |

## Files Changed

### New shared types
- `shared/modelCapabilityTypes.ts` — ModelCapabilityProfile, PromptProfileClass, CognitiveBudgetProfile, CompactionPolicy, CompactPromptPacket, CompactionDiagnosticsSummary, CompressedEmotionalBias, CompressedIdentityScaffold, CompactToolGuidance

### New services
- `electron/services/cognitive/ModelCapabilityClassifier.ts` — classification logic and budget profiles
- `electron/services/cognitive/PromptProfileSelector.ts` — profile selection with telemetry
- `electron/services/cognitive/IdentityCompressionPolicy.ts` — identity compression
- `electron/services/cognitive/ToolCompressionPolicy.ts` — tool guidance compression
- `electron/services/cognitive/EmotionalCompressionPolicy.ts` — emotional bias compression
- `electron/services/cognitive/CognitiveBudgetApplier.ts` — memory/doc/reflection budgeting
- `electron/services/cognitive/CognitiveContextCompactor.ts` — main compaction orchestrator

### Updated shared types
- `shared/telemetry.ts` — added 8 Phase 3B telemetry event types

### New tests
- `electron/__tests__/cognitive/ModelCapabilityClassifier.test.ts` — 20 tests
- `electron/__tests__/cognitive/CognitiveContextCompactor.test.ts` — 16 tests
- `electron/__tests__/cognitive/CompressionPolicies.test.ts` — 27 tests

## Backward Compatibility

The compaction layer is additive — it does not modify `CognitiveTurnAssembler`, `AgentService`, or any existing inference path. The `CognitiveContextCompactor` is a standalone service ready to be wired into the final prompt assembly path when Phase 3A integration work is complete.

The `TalaCognitiveContext.wasCompacted` flag (already present in Phase 3) is the hook for indicating when compaction was applied.
