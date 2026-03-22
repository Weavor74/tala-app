# P7B Context Determinism

## Design Goal

P7B hardens context assembly so that identical inputs always yield identical outputs.

Given the same:
- input turn / query
- memory state
- graph state
- retrieval results
- mode
- token budgets

the system must produce the same:
- selected context blocks
- item ordering
- exclusion decisions
- truncation decisions
- reason codes
- diagnostics

**Why this matters:** Without determinism, debugging assembly failures is guesswork. With determinism, any unexplained change in context composition has an identifiable cause.

---

## Core Rules

| Rule | Constraint |
|---|---|
| No arbitrary selection drift | Candidates are scored and sorted before selection, not taken in retrieval order |
| Prompt composition is explainable | Every included block has reason codes |
| Every exclusion has reason codes | No candidate disappears without a `ContextDecision` record |
| Token budget is global (P7D Feed 3) | Single `contextBudget.maxItems` + optional `maxTokens` covers all layers |
| Scoring formulas are deterministic | `ContextScoringService` with explicit weights, no LLM/ML |
| Tie-breaking rules are explicit and total | `compareContextCandidates` resolves all ties down to lexical ID |
| Ranking pipeline is repeatable | Same inputs always produce same `RankedContextCandidate[]` order |
| Unordered iteration cannot affect assembly | Candidates are converted to a scored+sorted list before selection |

---

## Deterministic Pipeline Stages

```
ContextAssemblyRequest
  │
  ▼
1. ResolvePolicy (MemoryPolicyService)
  │
  ▼
2. RetrieveOrchestrate (RetrievalOrchestrator)
   → NormalizedSearchResult[]
  │
  ▼
3. MapToItems (_mapResultToItem)
   → ContextAssemblyItem[] (all evidence candidates, unsorted)
  │
  ▼  [P7B step 3P]
4. ScoreAndRank — P7D Unified Pass (_rankItems, ALL candidates)
   → itemToCandidate() for each evidence + graph_context item
   → ContextScoringService.computeCandidateScore() (P7B base + P7D normalized score)
   → AffectiveWeightingService per-candidate adjustment (P7C gates per layerAssignment)
   → applyDeterministicTieBreak() → total-order sort
   → RankedContextCandidate[] (all sources, single unified order)
  │
  ▼
5. ExpandGraphContext (GraphTraversalService)
   → structural ContextAssemblyItem[]
  │
  ▼
6. GetAffectiveContext (AffectiveGraphService, optional)
   → affective ContextAssemblyItem[]
  │
  ▼
7. MergeGraphContextItems (_mergeGraphContextItems)
   → combined graph_context ContextAssemblyItem[] with deterministic sort
  │
  ▼  [P7D Feed 3]
8. GlobalCompetitiveSelection (_selectItemsGlobal)
   → ALL candidates compete under ONE global token + item budget
   → greedy iteration in rank order; per-document chunk cap for evidence
   → injected: ContextAssemblyItem[] (evidence, within budget)
   → graphContextItems: ContextAssemblyItem[] (graph_context, within budget)
   → latent: ContextAssemblyItem[] (evidence overflow, ranked order)
   → ContextDecision records for every candidate
  │
  ▼
11. AssembleResult
    → items: [...injected, ...graphContextItems, ...latent]
    → diagnostics: ContextAssemblyDiagnostics
  │
  ▼
ContextAssemblyResult (with diagnostics)
```

---

## Budget Model

### Layer names (`ContextLayerName`)

| Layer | Purpose | Priority |
|---|---|---|
| `system` | System/core instructions | 0 (reserved) |
| `evidence` | Retrieved evidence / RAG | 1 (highest) |
| `graph_context` | Graph-derived structural + affective context | 2 |
| `canonical_memory` | Canonical memory from the authority layer | 3 |
| `conversation` | Recent conversation history | 4 |
| `task_state` | Current task state | 5 |
| `policy_block` | Mode/policy blocks | 6 |

### Global budget (P7D Feed 3)

P7D Feed 3 replaced per-layer quota enforcement with a single global budget. `ContextAssemblyService._buildLayerBudgets()` still returns `ContextLayerBudget` records (for diagnostics), but the actual selection is performed by `_selectItemsGlobal()` using:

- `contextBudget.maxItems` — global item cap across all layers
- `contextBudget.maxTokens` — optional global soft token cap
- `contextBudget.minCanonicalItems` — optional floor that reserves slots for canonical items

The `maxItemsPerClass` field remains in `ContextBudgetPolicy` for backward compatibility, but per-class caps (`evidence`, `graph_context`) are no longer enforced during selection. The only per-class behavior retained is the per-document chunk cap for evidence items: `ceil(globalItemCap / 2)`.

### ContextLayerBudget (diagnostics)

```typescript
interface ContextLayerBudget {
  layer: ContextLayerName;
  maxItems: number;
  maxTokens?: number;    // soft token cap
  priority: number;      // lower = filled first
  overflowPolicy: 'truncate' | 'overflow_to_latent' | 'drop';
  canBorrow?: boolean;   // may borrow from lower-priority layers
}
```

Under P7D Feed 3, the layer budgets recorded in diagnostics reflect the global budget for `evidence` and `graph_context` layers (both show `maxItems` = `contextBudget.maxItems`).

### Overflow policy

| Policy | Behavior |
|---|---|
| `overflow_to_latent` | Evidence items beyond budget → `selectionClass: 'latent'` (included in result) |
| `drop` | Graph_context items beyond budget → excluded with `ContextDecision` record |
| `truncate` | Item content is truncated to fit (future extension) |

---

## Scoring Model

All scoring is implemented in `electron/services/context/ContextScoringService.ts`.

### Weights (`SCORING_WEIGHTS`)

| Component | Weight | Rationale |
|---|---|---|
| `semantic` | 0.40 | Retrieval relevance is the primary signal |
| `authority` | 0.25 | Canonical items should rank above derived/speculative |
| `recency` | 0.15 | Newer items preferred when relevance is similar |
| `source` | 0.10 | Source-type differentiation (extension point) |
| `graphDepth` | 0.05 | Minor penalty for deep graph hops |
| `affective` | 0.05 | Bounded affective adjustment |

Weights sum to 1.0. All are explicit constants that can be modified and tested independently.

### Authority tier scores (`AUTHORITY_TIER_SCORES`)

| Tier | Score |
|---|---|
| `canonical` | 1.0 |
| `verified_derived` | 0.75 |
| `transient` | 0.25 |
| `speculative` | 0.0 |
| `null` (unknown) | 0.5 (neutral) |

### Recency score

Linear decay from 1.0 (current) to 0.0 (28+ days old):

```
ageMs   = nowMs − timestamp_ms
score   = clamp(1.0 − ageMs / (4 × 7 days in ms), 0, 1)
```

Items with no timestamp receive a neutral score of 0.5.

### Graph depth penalty

```
penalty = −min(hopDepth × 0.10, 0.50)
```

Direct evidence (hopDepth = 0) receives no penalty.
Maximum penalty capped at −0.50 to prevent negative composite scores.

### Final score formula

```
finalScore =
  semanticScore * 0.40
  + authorityScore * 0.25
  + recencyScore * 0.15
  + sourceWeight * 0.10
  + graphDepthPenalty * 0.05
  + affectiveAdjustment * 0.05
```

---

## Tie-Break Rules

Implemented in `electron/services/context/contextCandidateComparator.ts`.

The comparator provides a **total order** — for any two distinct candidates, the same call always produces the same result. Ties at each level fall through to the next:

| Priority | Criterion | Direction | Tie means... |
|---|---|---|---|
| 1 | `authorityScore` | desc | Higher authority wins |
| 2 | `normalizedScore` | desc | Higher normalized score wins (P7D Feed 2) |
| 3 | `estimatedTokens` | asc | Smaller item wins (prefer compact) |
| 4 | `timestamp` | desc | More recent item wins |
| 5 | `id` (candidate ID / sourceKey) | asc (lexical) | Stable final tie-break |

The lexical ID tie-break guarantees that two distinct candidates can never compare as equal. This eliminates sort instability for any real candidate pool.

---

## Diagnostics Schema

`ContextAssemblyResult.diagnostics: ContextAssemblyDiagnostics` is always populated.

```typescript
interface ContextAssemblyDiagnostics {
  assemblyMode: string;           // GroundingMode value
  layerBudgets: ContextLayerBudget[];
  candidatePoolByLayer: Partial<Record<ContextLayerName, RankedContextCandidate[]>>;
  crossLayerCandidatePool: RankedContextCandidate[];
  crossLayerRankingOrder: string[];
  decisions: ContextDecision[];   // one per candidate — no omissions
  perSourceInclusionCounts: Record<string, number>;
  exclusionReasonsBySource: Record<string, Partial<Record<ContextDecisionReason, number>>>;
  authorityConflictRecords: ConflictResolutionRecord[];
  normalizationBreakdown: NormalizationBreakdownEntry[];
  includedCandidates: string[];
  excludedCandidates: string[];
  truncatedCandidates: string[];
  latentCandidates: string[];
  finalTokenUsageByLayer: Partial<Record<ContextLayerName, number>>;
  tieBreakRecords: TieBreakRecord[];
  conflictResolutionRecords: ConflictResolutionRecord[];
  totalCandidatesConsidered: number;
  totalIncluded: number;
}
```

Cross-layer diagnostics fields are populated from the unified candidate pool:

- `crossLayerCandidatePool` and `crossLayerRankingOrder` show the exact ordering used by the global selection pass.
- `perSourceInclusionCounts` and `exclusionReasonsBySource` make it explicit why a source layer (rag, graph, mem0, etc.) was included or excluded.
- `authorityConflictRecords` mirrors `conflictResolutionRecords` for direct authority-focused inspection.
- `normalizationBreakdown` lists `finalScore`, `sourceWeight`, `tokenEfficiency`, and `normalizedScore` per candidate so ranking effects from normalization are transparent.

### ContextDecision fields

| Field | Description |
|---|---|
| `candidateId` | Stable ID of the candidate (sourceKey or fallback) |
| `status` | `'included'` / `'excluded'` / `'truncated'` / `'latent'` |
| `reasons` | One or more `ContextDecisionReason` codes |
| `finalScore` | Composite score at decision time |
| `estimatedTokens` | Token cost of this candidate |
| `tieBreakApplied` | Whether the comparator's lower-priority criteria were needed |
| `tieBreakWinner` | Whether this candidate won the tie-break |
| `conflictResolved` | Whether a canonical/derived conflict was resolved for this candidate |

### Reason codes (`ContextDecisionReason`)

| Code | When used |
|---|---|
| `included.high_authority` | Candidate has `canonical` authority tier |
| `included.cross_layer_top_rank` | Candidate included in global cross-layer competition (P7D Feed 3) |
| `included.canonical_memory_priority` | P7A canonical memory included first |
| `excluded.cross_layer_budget_exceeded` | Global item or token budget exhausted (P7D Feed 3) |
| `excluded.outcompeted_by_higher_rank` | Per-document cap hit; higher-ranked chunk from same doc took the slot (P7D Feed 3) |
| `excluded.per_document_cap` | Per-document chunk cap already reached |
| `excluded.lower_rank_than_canonical` | Canonical item outranked this candidate |
| `excluded.tie_break_lost` | Lost a deterministic tie-break |
| `excluded.authority_conflict_lost` | Canonical vs. derived conflict resolution |
| `overflow.to_latent` | Budget exhausted; evidence item moved to latent class |
| `truncated.to_fit_budget` | Content was truncated (future extension) |

---

## Canonical Authority Rule (P7A Integration)

P7B respects the P7A read authority rule:

- Canonical items (`authorityTier = 'canonical'`) receive the highest authority score (1.0)
- This guarantees canonical items rank above `verified_derived`, `transient`, and `speculative` items with equal semantic scores
- The comparator's first criterion is authority score, so canonical items can never be displaced by higher-scoring derived items
- `ConflictResolutionRecord` entries are written when canonical and derived candidates are detected to represent the same content

Authority tier derivation for graph_context items:

| `graphEdgeTrust` | `authorityTier` |
|---|---|
| `canonical` or `explicit` | `canonical` |
| `derived` or `inferred_high` | `verified_derived` |
| `inferred_low` | `transient` |
| `session_only` | `speculative` |
| missing | `null` (neutral = 0.5) |

For evidence items from retrieval, authority tier defaults to `null` (neutral). Future work can enrich this from `MemoryAuthorityService` lookup.

---

## New Files

| File | Purpose |
|---|---|
| `shared/context/contextDeterminismTypes.ts` | All P7B shared types (ContextLayerName, ContextLayerBudget, ScoreBreakdown, ContextCandidate, RankedContextCandidate, ContextDecisionReason, ContextDecision, TieBreakRecord, ConflictResolutionRecord, ContextAssemblyDiagnostics) |
| `electron/services/context/ContextScoringService.ts` | Deterministic scoring formulas (SCORING_WEIGHTS, AUTHORITY_TIER_SCORES, computeCandidateScore, computeRecencyScore, computeAuthorityScore, computeGraphDepthPenalty) |
| `electron/services/context/contextCandidateComparator.ts` | Total-order comparator (compareContextCandidates, applyDeterministicTieBreak) |
| `tests/P7BContextDeterminism.test.ts` | 40 determinism tests covering repeatability, reason codes, tie-breaks, budgets, authority, diagnostics |

## Modified Files

| File | Change |
|---|---|
| `electron/services/context/ContextAssemblyService.ts` | Added deterministic scoring + ranking pipeline, decision tracking, diagnostics emission |
| `shared/policy/memoryPolicyTypes.ts` | Added `diagnostics?: ContextAssemblyDiagnostics` to `ContextAssemblyResult`; added P7B imports |

---

## Known Constraints

1. **Evidence authority tier not yet enriched from MemoryAuthorityService.** Retrieval results carry no authority tier metadata. Evidence items receive a neutral authority score (0.5). A future P7B.1 pass can enrich evidence items with canonical tier from `MemoryAuthorityService.rankMemoryByAuthority()`.

2. **Token truncation not yet implemented.** The `truncate` overflow policy is defined but not yet triggered. Items are currently excluded rather than truncated. This is a safe conservative default.

3. **Graph hop depth is fixed at 1.** `GraphTraversalService` derives all graph_context items from evidence seeds in a single expansion. The graph depth penalty infrastructure is in place for when multi-hop traversal is added.

4. **Recency timestamp sourced from `metadata.fetchedAt`.** If a retrieval provider does not populate `fetchedAt`, items receive neutral recency scoring. This is correct behavior but may reduce recency signal quality for some providers.

---

## Future Extension Points

- **Source-specific weights:** `SCORING_WEIGHTS.source` currently defaults to 1.0 for all sources. Future work can adjust per `providerId` or `sourceType`.
- **Canonical tier enrichment from MemoryAuthorityService:** Enrich evidence items with their actual `MemoryAuthorityTier` via a lookup after retrieval.
- **Content truncation policy:** Implement `truncate` overflow policy to fit long items rather than excluding them.
- **Budget borrowing:** `ContextLayerBudget.canBorrow` is defined; implement the multi-layer borrow algorithm.
- **Diagnostics persistence:** Serialize `ContextAssemblyDiagnostics` to the audit log for long-term assembly traceability.

---

*Implemented as part of P7B Context Determinism. See also: `docs/architecture/context_assembly.md`, `docs/architecture/p7a_hardening_audit.md`.*
