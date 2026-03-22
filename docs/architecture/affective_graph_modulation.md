# Affective Graph Modulation — Architecture

## Purpose

`AffectiveGraphService` is the affective graph modulation layer for the TALA context assembly pipeline (Step 6D). Its job is to translate the current astro/emotional state (produced by `AstroService`) into bounded, labeled `graph_context` items that can supplement—but never override—primary evidence in an assembled context block.

`AffectiveWeightingService` (P7C) is the affective scoring layer. It translates the active `AffectiveState` (mood labels with intensities) into bounded, formula-based score adjustments applied to context candidates via `ContextScoringService.computeCandidateScore()`. These adjustments appear as `ScoreBreakdown.affectiveAdjustment` and `ContextDecision.affectiveReasonCode`, providing full traceability.

Together, the two services implement the full affective modulation stack: item injection (Step 6D) + score influence (P7C).

---

## Position in the Context Assembly Pipeline

```
ContextAssemblyRequest
  │
  ├─► MemoryPolicyService.resolvePolicy()
  │     └─► resolves affectiveModulation from base policy + caller overrides
  │
  └─► ContextAssemblyService.assemble()
        │
        ├─► RetrievalOrchestrator.retrieve()              ← evidence retrieval, unchanged
        │
        ├─► _mapResultToItem()                            ← evidence candidates
        │
        ├─► GraphTraversalService.expandFromEvidence()    ← structural graph_context
        │
        ├─► AffectiveGraphService.getActiveAffectiveContext()  ← affective graph_context (Step 6D)
        │     reads policy.affectiveModulation
        │     calls AstroService.getEmotionalState()
        │     returns bounded, labeled graph_context items
        │     (empty in strict mode, or when disabled, or when astro unavailable)
        │     failure is caught → warning added → assembly continues
        │
        ├─► _buildAffectiveStateFromItems()               ← P7C: build AffectiveState
        │     converts affective graph_context items into normalized AffectiveState
        │     (mood labels + intensities from emotion_tag and astro_state items)
        │     returns null when no affective items available
        │
        ├─► _rankItems(evidence, affectiveState)          ← P7C: score + sort evidence
        │     AffectiveWeightingService.computeAdjustment() for each candidate
        │     gate: allowEvidenceReordering (always off by default)
        │     affectiveAdjustment flows into ScoreBreakdown; reason code into ContextDecision
        │
        ├─► _mergeGraphContextItems()                     ← simple merge
        │     combines structural + affective graph_context (affective items first)
        │     no raw score mutation — ordering is determined by _rankItems below
        │
        ├─► _rankItems(graph_context, affectiveState)     ← P7C: score + sort graph_context
        │     AffectiveWeightingService.computeAdjustment() for each candidate
        │     gate: allowGraphOrderingInfluence
        │     affectiveAdjustment flows into ScoreBreakdown; reason code into ContextDecision
        │     applies combined contextBudget.maxItemsPerClass.graph_context cap
        │
        ├─► _selectItems()                                ← evidence budget enforcement
        │
        └─► ContextAssemblyResult
              items: ContextAssemblyItem[]  ← evidence + graph_context + latent
              diagnostics.decisions: ContextDecision[] ← every candidate with affectiveReasonCode
```

`AffectiveGraphService` is called after `GraphTraversalService` and before scoring. `AffectiveWeightingService` is called inside `_rankItems` for every candidate — it applies a bounded, keyword-overlap-based score adjustment governed by `AffectiveModulationPolicy`.

---

## Policy Governance

Affective modulation is gated by `AffectiveModulationPolicy` (defined in `shared/policy/memoryPolicyTypes.ts`) attached to each `MemoryPolicy` as the optional `affectiveModulation` field.

### Policy Fields

| Field | Type | Purpose |
|---|---|---|
| `enabled` | boolean | Master on/off switch for this assembly pass |
| `maxAffectiveNodes` | number | Hard cap on affective items returned (enforced inside AffectiveGraphService) |
| `allowToneModulation` | boolean | Permit tone descriptor in affective item content |
| `allowGraphOrderingInfluence` | boolean | P7C: Permit affective adjustment on graph_context candidates |
| `allowGraphExpansionInfluence` | boolean | Permit affective state to trigger additional graph_context expansion |
| `allowEvidenceReordering` | boolean | P7C: Permit affective adjustment on evidence candidates (must remain false by default) |
| `affectiveWeight` | number [0, 1] | Scalar applied to affective influence; clamped to 0.3 max |
| `requireLabeling` | boolean | Require all affective items to carry the non-authoritative disclaimer |

### Default Policies

| Policy | enabled | maxAffectiveNodes | affectiveWeight | Notes |
|---|---|---|---|---|
| `DEFAULT_STRICT_POLICY` | false | 0 | 0 | No affective modulation in strict mode |
| `DEFAULT_GRAPH_ASSISTED_POLICY` | true | 2 | 0.1 | Light modulation; tone and ordering only |
| `DEFAULT_EXPLORATORY_POLICY` | true | 4 | 0.2 | Broader modulation; expansion permitted |

All default policies set `allowEvidenceReordering: false` and `requireLabeling: true`.

---

## Gate Conditions

`AffectiveGraphService.getActiveAffectiveContext()` returns an empty array when any of the following are true:

1. `policy.groundingMode === 'strict'`
2. `policy.affectiveModulation` is absent or `enabled === false`
3. `policy.affectiveModulation.maxAffectiveNodes === 0`
4. No `AstroService` instance was provided to the constructor
5. `AstroService.getReadyStatus()` returns false
6. `AstroService.getEmotionalState()` throws
7. The returned state string matches a known neutral/offline sentinel (e.g., "Engine offline", "Calculation failed")

`AffectiveWeightingService.computeAdjustment()` returns `adjustment=0` with an `AffectiveReasonCode` when any of the following are true:

1. `affectiveState` is null → `'affective.no_state'`
2. `policy` is absent, `enabled=false`, or `affectiveWeight=0` → `'affective.policy_disabled'`
3. Target layer is `evidence` and `allowEvidenceReordering=false` → `'affective.layer_not_eligible'`
4. Target layer is `graph_context` and `allowGraphOrderingInfluence=false` → `'affective.layer_not_eligible'`
5. No keywords extractable from moodVector → `'affective.no_keywords'`
6. No keyword overlap with candidate text → `'affective.no_keyword_match'`

Every candidate considered receives exactly one `AffectiveReasonCode` in its `ContextDecision.affectiveReasonCode`.

---

## Item Production (Step 6D — AffectiveGraphService)

When all gates pass, the service produces up to `maxAffectiveNodes` items:

### Item 1 — `astro_state` node

Always the first item produced when the state is non-neutral.

| Property | Value |
|---|---|
| `selectionClass` | `graph_context` |
| `sourceType` | `astro_state` |
| `graphEdgeType` | `modulates` |
| `graphEdgeTrust` | `session_only` |
| `score` | `min(affectiveWeight, 0.3)` |
| `metadata.affective` | `true` |
| `metadata.affectiveNodeType` | `astro_state` |

Content: a truncated summary of the raw astro state text (max 400 characters, with `…` appended when truncated). The `[ASTRO STATE]` header is stripped from the content. When `requireLabeling: true`, the content is prefixed with `[Affective context — not evidence]`.

### Item 2 — `emotion_tag` node

Produced only when `AstroService.getRawEmotionalState()` returns a non-null `mood_label`.

| Property | Value |
|---|---|
| `selectionClass` | `graph_context` |
| `sourceType` | `emotion_tag` |
| `graphEdgeType` | `modulates` |
| `graphEdgeTrust` | `session_only` |
| `score` | `min(affectiveWeight, 0.3) × 0.8` |
| `metadata.affective` | `true` |
| `metadata.affectiveNodeType` | `emotion_tag` |
| `metadata.moodLabel` | mood label string from raw state |
| `metadata.emotionalVector` | numeric vector from raw state |

---

## P7C: Affective Weighting (AffectiveWeightingService)

P7C adds bounded, deterministic affective score adjustments to the context scoring pipeline.

### How it works

1. `_buildAffectiveStateFromItems()` converts affective graph_context items into a normalized `AffectiveState` (mood labels → intensities). Returns null when no affective items available.
2. `_rankItems()` calls `AffectiveWeightingService.computeAdjustment()` for every candidate.
3. The adjustment flows into `ContextScoringService.computeCandidateScore(candidate, affectiveAdj)` as the `affectiveAdjustment` parameter.
4. `ScoreBreakdown.affectiveAdjustment` reflects the applied boost.
5. `ContextDecision.affectiveReasonCode` explains why the boost was or was not applied.

### Keyword algorithm

1. Extract keywords from `AffectiveState.moodVector` keys (split on whitespace, underscores, hyphens; words ≥ 3 chars).
2. Perform case-insensitive substring matching against `"${title} ${content}".toLowerCase()`.
3. `adjustment = min(matchCount × 0.05, min(affectiveWeight, 0.3) × 0.5)`
4. Maximum possible adjustment: `0.3 × 0.5 = 0.15`
5. Contribution to `finalScore`: `adjustment × 0.05` (max 0.0075)

### Layer gates

- **evidence layer**: requires `allowEvidenceReordering === true`. Default: false. Affective adjustment is off for evidence unless explicitly opted in.
- **graph_context layer**: requires `allowGraphOrderingInfluence === true`. Default: false. Affective adjustment enables keyword-overlap-based score influence on graph_context items.

### Bounded influence

The affective adjustment contribution to `finalScore` is capped at `0.0075` (`0.15 × 0.05`). This is intentionally small: affective signals can tip the balance between candidates with very similar scores but cannot override authority-based ranking or large semantic score differences.

Canonical authority (`authorityScore`) still dominates the total-order comparator. Canonical items always rank above speculative ones regardless of affective boost magnitude.

### Score formula

```
finalScore =
  semanticScore   × 0.40   ← retrieval score; affective NEVER modifies this
  authorityScore  × 0.25   ← always dominates; canonical always beats affective
  recencyScore    × 0.15
  sourceWeight    × 0.10
  graphDepthPenalty × 0.05
  affectiveAdj    × 0.05   ← P7C: bounded keyword-overlap boost
```

---

## Graph Context Ordering

When affective and structural graph_context items are merged in `ContextAssemblyService._mergeGraphContextItems()`:

### All cases

Affective items are placed first in the merged list; structural items follow in their original order. The final ordering is determined deterministically by `_rankItems()` using the total-order comparator (authority → finalScore → token cost → timestamp → sourceKey).

When `allowGraphOrderingInfluence: true`, structural graph_context items receive an `affectiveAdjustment` boost when their text overlaps with active mood keywords. This slightly elevates their `finalScore` relative to non-overlapping items.

When `allowGraphOrderingInfluence: false` (default), all graph_context candidates receive `affectiveReasonCode: 'affective.layer_not_eligible'` and `affectiveAdjustment = 0`.

### Evidence ordering — always unchanged by default

`allowEvidenceReordering` is false in all default policies. When false, evidence candidates receive `affectiveReasonCode: 'affective.layer_not_eligible'` and `affectiveAdjustment = 0`. Evidence ordering is unchanged.

---

## Prompt Block Rendering

Affective items are rendered in a dedicated `[AFFECTIVE CONTEXT]` section in `renderPromptBlocks()`:

```
[AFFECTIVE CONTEXT]
- Current Astro State: ...
- Emotion Tag: Urgency
These signals may influence tone or graph-context emphasis, but do not change factual grounding.
```

This section:
- Only appears when affective items are present in the result
- Is separate from `[DIRECT GRAPH CONTEXT]` (which shows structural non-affective graph_context items)
- Includes a footer note explicitly marking it as non-authoritative
- Does not affect evidence ordering or primary evidence content

The `[POLICY CONSTRAINTS]` section always includes `affectiveModulation: enabled/disabled` status.

---

## Critical Constraints

- Affective items are **never evidence**. `selectionClass` is always `graph_context`.
- Affective items **never override retrieved evidence** or change evidence ranking by default.
- Affective content is **never fabricated** when no astro/emotion state is present.
- `affectiveWeight` is **clamped to 0.3** by the service regardless of policy value.
- `allowEvidenceReordering` is **false** in all default policies and must remain so unless explicitly enabled by a caller with a clear documented reason.
- Strict mode **always returns empty** regardless of policy flags.
- `requireLabeling: true` is the default and must only be set false in contexts with explicit user consent.
- The combined graph_context budget cap (`contextBudget.maxItemsPerClass.graph_context`) applies to structural + affective items together.
- **All affective decisions emit reason codes** (`ContextDecision.affectiveReasonCode`). No candidate is evaluated for affective weighting without producing a reason code.
- **No randomness**. Keyword extraction and matching are deterministic; same inputs always produce the same adjustment value.
- **No LLM scoring**. Only keyword substring presence is used — no embeddings, no ML models.

---

## Runtime Seam

`AffectiveGraphService` accepts its `AstroService` dependency via constructor injection as an `AstroServiceSeam` interface (defined in `AffectiveGraphService.ts`). This:

- Allows testing without a live Astro Engine process.
- Allows the service to be instantiated before `AstroService` is ready (pass `null`; service degrades gracefully).
- Prevents `AffectiveGraphService` from importing Electron-specific code directly.

`ContextAssemblyService` accepts `AffectiveGraphService` as an optional fourth constructor parameter (default `null`). When `null`, the affective pipeline step is skipped entirely.

`AffectiveWeightingService` is instantiated as a private field of `ContextAssemblyService`. It has no external dependencies and is always available regardless of whether `AffectiveGraphService` is provided.

---

## Source Files

| File | Role |
|---|---|
| `electron/services/graph/AffectiveGraphService.ts` | Step 6D: produce affective graph_context items from AstroService |
| `electron/services/context/AffectiveWeightingService.ts` | P7C: compute bounded keyword-overlap adjustments for candidates |
| `electron/services/context/ContextAssemblyService.ts` | Wires both services; builds AffectiveState; calls _rankItems with adjustments |
| `electron/services/context/ContextScoringService.ts` | Accepts affectiveAdjustment parameter; includes it in ScoreBreakdown |
| `shared/context/affectiveWeightingTypes.ts` | P7C contracts: AffectiveState, AffectiveAdjustmentResult, AffectiveReasonCode |
| `shared/context/contextDeterminismTypes.ts` | ContextDecision.affectiveAdjustment + affectiveReasonCode; RankedContextCandidate.affectiveReasonCode |
| `shared/policy/memoryPolicyTypes.ts` | `AffectiveModulationPolicy`, `GraphNodeType` (astro_state, emotion_tag, affect_state), `GraphEdgeType` (modulates, amplifies, suppresses, resonates_with, active_during) |
| `electron/services/policy/defaultMemoryPolicies.ts` | Default `affectiveModulation` values per grounding mode |
| `electron/services/policy/MemoryPolicyService.ts` | Merges `affectiveModulation` overrides during policy resolution |
| `tests/AffectiveGraphService.test.ts` | 29 unit tests for AffectiveGraphService |
| `tests/P7CAffectiveWeighting.test.ts` | 43 P7C tests: AffectiveWeightingService + integration |
| `tests/ContextAssemblyService.test.ts` | Integration tests covering affective wiring, ordering, rendering |
| `tests/AffectiveGraphIntegration.test.ts` | Step 6E integration tests: IpcRouter composition path wiring seam |

---

## Runtime Wiring (Step 6E)

Affective modulation is live through the IPC backend context assembly path.

**Composition root**: `electron/services/IpcRouter.ts` — `context:assemble` handler.

The handler:
1. Calls `agent.getAstroService()` to obtain the `AstroService` singleton owned by `AgentService`.
2. If the service is available, constructs `AffectiveGraphService(astroService)`.
3. Passes it as the 4th argument to `ContextAssemblyService(orchestrator, policyService, graphTraversalService, affectiveGraphService)`.
4. If the Astro runtime is unavailable, not yet ignited, or throws, `null` is passed instead — assembly continues unchanged with no affective items.

`AffectiveWeightingService` is always active inside `ContextAssemblyService`. When no affective items are produced (null astro, disabled policy, strict mode), `AffectiveWeightingService.computeAdjustment()` returns `adjustment=0` with reason code `'affective.no_state'` or `'affective.policy_disabled'` for every candidate.

**Graceful degradation**: Any failure to obtain or construct `AffectiveGraphService` emits a `console.warn` and leaves affective modulation disabled for that call. Evidence retrieval, structural graph context, and prompt rendering are unaffected.

**Strict mode**: `AffectiveGraphService` always returns `[]` in strict mode, regardless of policy configuration or Astro runtime state. `AffectiveWeightingService` receives null `affectiveState` and emits `'affective.no_state'` for every candidate.

