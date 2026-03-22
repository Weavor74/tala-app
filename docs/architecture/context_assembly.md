# Context Assembly — Architecture

## Purpose

`ContextAssemblyService` is the runtime implementation of the TALA context assembly layer (Step 5B + Step 6A + Step 6D). Its job is to transform retrieval results into policy-governed, prompt-ready context that can be injected into an LLM turn.

Graph-aware context enrichment is provided by `GraphTraversalService` (Step 6A). It runs after evidence mapping and derives structural `graph_context` candidates from evidence seeds before budget enforcement is applied.

Affective context modulation is provided by `AffectiveGraphService` (Step 6D). It runs after structural graph traversal and adds bounded, clearly-labeled affective `graph_context` items from the current astro/emotional state, subject to `policy.affectiveModulation`. In strict mode or when the service is absent, assembly behavior is unchanged.

Before these services existed, the retrieval and prompt assembly layers were loosely coupled through ad-hoc logic in `TalaContextRouter` and `ContextAssembler`. `ContextAssemblyService` provides a clean seam: retrieval produces candidates, graph traversal enriches them structurally, affective modulation adds labeled emotional context, policy decides what enters context, and the assembler formats the result.

---

## Relationship Between Retrieval, Graph Traversal, Affective Modulation, Policy, and Context Assembly

```
ContextAssemblyRequest
  │
  ├─► MemoryPolicyService.resolvePolicy()
  │     └─► selects base policy from defaultMemoryPolicies.ts
  │         merges caller overrides (including affectiveModulation)
  │         derives scope (notebook/global from notebookId)
  │         returns resolved MemoryPolicy
  │
  └─► ContextAssemblyService.assemble()
        │
        ├─► RetrievalOrchestrator.retrieve()             ← existing layer, unchanged
        │     uses policy.retrievalMode + policy.scope
        │
        ├─► _mapResultToItem()                           ← preserves all citation/provenance
        │     returns evidence candidates (all selectionClass='evidence')
        │
        ├─► GraphTraversalService.expandFromEvidence()   ← Step 6A: structural graph_context
        │     accepts evidence candidates as seeds
        │     derives graph_context candidates from shared documentId (co-occurrence)
        │     enforces policy.graphTraversal constraints
        │     returns graph_context items with edge type + trust labels
        │     (empty when traversal disabled or strict mode)
        │
        ├─► AffectiveGraphService.getActiveAffectiveContext()  ← Step 6D: affective graph_context
        │     reads policy.affectiveModulation
        │     calls AstroService.getEmotionalState() via AstroServiceSeam
        │     returns bounded, labeled graph_context items (selectionClass='graph_context')
        │     items carry graphEdgeType='modulates', graphEdgeTrust='session_only'
        │     items carry metadata.affective=true and optional disclaimer label
        │     (empty in strict mode, when disabled, when service absent, or astro unavailable)
        │     graceful degradation: failure adds warning, assembly continues unaffected
        │     See: docs/architecture/affective_graph_modulation.md
        │
        ├─► _mergeGraphContextItems()                    ← merge structural + affective graph_context
        │     merges structural + affective graph_context candidates
        │     if allowGraphOrderingInfluence=false: affective items placed first, structural unchanged
        │     if allowGraphOrderingInfluence=true: structural items receive small keyword-overlap boost
        │     evidence ordering is NEVER affected by this step
        │
        ├─► _rankItems()                                  ← P7D: unified scoring + ranking pass
        │     ALL candidates (evidence + graph_context) scored and sorted in ONE pass
        │     ContextScoringService computes ScoreBreakdown (P7B base + P7D normalized score)
        │     AffectiveWeightingService applies per-candidate affective adjustments (P7C)
        │     applyDeterministicTieBreak() enforces total-order sort (P7B)
        │
        ├─► _selectItemsGlobal()                          ← P7D Feed 3: single global budget selection
        │     ALL candidates compete under ONE global token + item budget
        │     no per-layer quota enforcement (per-class caps removed)
        │     greedy selection in rank order until global budget exhausted
        │     evidence overflow → latent (never dropped)
        │     graph_context overflow → excluded (decision record produced)
        │     optional minCanonicalItems floor: canonical items bypass global cap
        │     per-document chunk cap still applies to evidence items
        │
        └─► ContextAssemblyResult
              items: ContextAssemblyItem[]     ← evidence + graph_context + latent
              policy: MemoryPolicy
              itemCountByClass
              estimatedTokens
              durationMs
              warnings
              diagnostics                      ← P7B: ContextAssemblyDiagnostics (always populated)
```

The assembly layers are kept strictly separate:

| Layer | File | Responsibility |
|---|---|---|
| Retrieval | `RetrievalOrchestrator.ts` | Fetch, merge, deduplicate candidates |
| Policy | `MemoryPolicyService.ts` | Resolve active policy from request (including affectiveModulation) |
| Graph Traversal | `GraphTraversalService.ts` | Expand evidence seeds into structural graph_context candidates |
| Affective Modulation | `AffectiveGraphService.ts` | Produce bounded, labeled affective graph_context from astro/emotional state |
| **Scoring (P7B)** | **`ContextScoringService.ts`** | **Deterministic candidate scoring with explicit weight formula** |
| **Ranking (P7B)** | **`contextCandidateComparator.ts`** | **Total-order tie-break comparator; always produces same sort** |
| Assembly | `ContextAssemblyService.ts` | Select, classify, budget, format, emit diagnostics |

Policy does not call retrieval. Retrieval does not know about policy. Graph traversal receives only evidence items and policy — it does not call retrieval. Affective modulation receives only policy and query text — it does not access evidence items. The assembler is the only layer that calls all others.

---

## P7B Context Determinism

P7B (implemented in this service) ensures context assembly is deterministic:

- **Score before select.** After mapping retrieval results to `ContextAssemblyItem[]`, the assembler converts each item to a `ContextCandidate`, computes a `ScoreBreakdown` via `ContextScoringService`, and sorts the candidates using the total-order comparator from `contextCandidateComparator.ts`. Selection then operates on this deterministically ordered list — retrieval order never determines assembly order.

- **Total-order tie-breaking.** `compareContextCandidates` provides a 5-level tie-break: authority score → final score → token cost → timestamp → lexical ID. Two distinct candidates can never compare as equal.

- **Decision records for every candidate.** `_selectItemsGlobal` produces a `ContextDecision` for each candidate. No candidate can disappear without an explicit reason code. Reason codes include `included.cross_layer_top_rank`, `included.high_authority`, `excluded.cross_layer_budget_exceeded`, `excluded.outcompeted_by_higher_rank`, `overflow.to_latent`, `excluded.per_document_cap`, and `truncated.*`.

- **Diagnostics always populated.** `ContextAssemblyResult.diagnostics` (`ContextAssemblyDiagnostics`) is always set. It includes the full candidate pool by layer, the unified cross-layer ranking order, per-source inclusion/exclusion breakdowns, score/normalization components, all decisions, tie-break records, and final token usage by layer.

See `docs/architecture/p7b_context_determinism.md` for the full scoring model, tie-break rules, and budget model.

---

## Evidence-First Grounding

All context assembly passes enforce evidence-first grounding:

- Evidence items (retrieved documents, chunks, notebook items) rank ahead of graph_context items with lower authority tier in the unified ranking pass.
- `contextBudget.evidencePriority = true` in all three default policies.
- In `strict` mode, only evidence items enter context. Graph traversal is skipped, affective modulation is skipped, and no graph_context items are added.
- In `graph_assisted` and `exploratory` modes, ALL candidates (evidence + graph_context) compete under a single global budget. Evidence items typically rank above graph_context items because evidence items use authority tier `null` (neutral 0.5), while graph_context items derived from 'derived' edge trust receive `verified_derived` (0.75). The total-order comparator puts higher authority first, so structural graph_context items with `derived` trust can rank above evidence.
- Affective items are **never** placed in the `evidence` class. They remain `graph_context` regardless of policy.
- Affective modulation never reorders evidence items (`allowEvidenceReordering: false` in all default policies).

This prevents the model from drawing on unsupported context when real evidence exists.

---

## Grounding Modes

Three grounding modes are defined in `shared/policy/memoryPolicyTypes.ts` and implemented via default policies in `electron/services/policy/defaultMemoryPolicies.ts`:

### `strict`

- `graphTraversal.enabled = false`
- `affectiveModulation.enabled = false`
- `GraphTraversalService` is not called; `AffectiveGraphService` is not called
- No graph_context items are ever added in strict mode
- Conservative budgets: `maxItems: 10`, `maxTokens: 4096`
- Use when the model must be grounded only in retrieved evidence

### `graph_assisted`

- `graphTraversal.enabled = true`, `maxHopDepth: 1`
- `affectiveModulation.enabled = true`, `maxAffectiveNodes: 2`, `affectiveWeight: 0.1`
- `GraphTraversalService` derives document co-occurrence graph_context nodes from evidence seeds
- `AffectiveGraphService` adds up to 2 labeled affective graph_context items
- Default `allowedEdgeTypes`: `supports, cites, related_to, mentions, about`
- Moderate budgets: `maxItems: 15`, `maxTokens: 6144`
- Default when no groundingMode is specified

### `exploratory`

- `graphTraversal.enabled = true`, `maxHopDepth: 2`
- `affectiveModulation.enabled = true`, `maxAffectiveNodes: 4`, `affectiveWeight: 0.2`
- More permissive traversal settings (`minEdgeTrustLevel: inferred_low`)
- `AffectiveGraphService` adds up to 4 labeled affective graph_context items
- Larger budgets: `maxItems: 20`, `maxTokens: 8192`
- Use for broad context passes where evidence is preferred but not mandatory

---

## Graph Traversal Layer (Step 6A)

`GraphTraversalService` is the first minimal graph runtime for TALA. It runs in-process and derives `graph_context` candidates from evidence items without requiring a separate graph database.

### What it does

1. **Accepts evidence items as seed nodes.** Only items already selected by retrieval can act as seeds. No unsupported nodes are introduced.
2. **Derives document co-occurrence nodes.** When 2 or more evidence chunks share the same `documentId`, the containing document is an implicit graph node related to all of them via a `contains` edge. One `graph_context` item is emitted per qualifying document.
3. **Enforces all `policy.graphTraversal` constraints**: `enabled`, `maxHopDepth`, `maxRelatedNodes`, `maxNodesPerType`, `minEdgeTrustLevel`, `allowedEdgeTypes`.
4. **Returns bounded, labeled graph_context items** with correct `graphEdgeType`, `graphEdgeTrust`, and provenance metadata.

### Edge label and trust on derived nodes

| Property | Value | Reason |
|---|---|---|
| `graphEdgeType` | `contains` | The document node contains the evidence chunks |
| `graphEdgeTrust` | `derived` | Inferred from shared `documentId` metadata, not explicitly authored |
| `graphNodeType` (metadata) | `source_document` | The derived node represents a source document |

### What it does NOT do

- Does not call the `tala-memory-graph` MCP server.
- Does not fabricate nodes that have no basis in evidence metadata.
- Does not perform multi-hop traversal beyond what can be derived from evidence provenance.

### Future integration

When a graph database is available, `expandFromEvidence()` will route to it first and fall back to provenance-derived expansion when unavailable. The return contract (`ContextAssemblyItem[]` with `selectionClass: 'graph_context'`) does not change. `ContextAssemblyService` requires no further modification.

---

## Affective Modulation Layer (Step 6D)

`AffectiveGraphService` is the affective context layer for TALA. It runs after structural graph traversal and adds bounded, clearly-labeled `graph_context` items derived from the current astro/emotional state.

### Critical constraints

- Affective items are **never evidence**. `selectionClass` is always `graph_context`.
- Affective items carry `metadata.affective = true` to distinguish them from structural graph_context.
- Affective content is **never fabricated** — if no astro state is available, no items are produced.
- `affectiveWeight` is clamped to 0.3 by the service regardless of policy.
- Evidence ordering is **never affected** by affective modulation (`allowEvidenceReordering: false` by default).
- Strict mode **always returns empty** from `AffectiveGraphService`, regardless of policy flags.
- The service is **optional** in `ContextAssemblyService`. When absent (`null`), behavior is identical to the previous implementation.

### Graph_context ordering influence

When affective items are merged with structural graph_context items in `_mergeGraphContextItems()`:

- **`allowGraphOrderingInfluence: false` (default):** Affective items are placed first in the graph_context list; structural items retain their original order. Evidence items are never touched.
- **`allowGraphOrderingInfluence: true`:** Structural graph_context items receive a small keyword-overlap boost when their title/content matches active mood labels or astro tags. The boost is capped at `affectiveWeight × 0.5` (max 0.15). Affective items still lead the list. Evidence items are still never touched.

The combined graph_context list (structural + affective) is passed to `_rankItems()` together with all evidence candidates. There is no longer a separate per-class cap for graph_context items. Instead, all candidates compete under the global budget set by `contextBudget.maxItems` and `contextBudget.maxTokens`. See the Budget Enforcement section below.

### Graceful degradation

If `AffectiveGraphService.getActiveAffectiveContext()` throws, the exception is caught, a warning is added to `ContextAssemblyResult.warnings`, and assembly continues with an empty affective item list. The rest of the pipeline is unaffected.

See: `docs/architecture/affective_graph_modulation.md` for full gate conditions and item production rules.

---

## Budget Enforcement (P7D Feed 3: Global Competitive Selection)

`ContextAssemblyService._selectItemsGlobal()` applies a single global budget to ALL candidates (evidence + graph_context combined). Per-layer quota enforcement has been replaced by competitive selection:

1. All candidates are ranked in the unified pass via `_rankItems()` using the total-order comparator.
2. The assembler iterates through the ranked pool in rank order (highest rank first).
3. A candidate is included when:
   - The global item cap (`contextBudget.maxItems`) has not been reached, AND
   - The global token cap (`contextBudget.maxTokens`, optional) has room for the candidate's token cost, AND
   - The per-document chunk cap has not been reached (evidence items only).
4. Evidence candidates that exceed the global budget are moved to `latent` (not dropped).
5. Graph_context candidates that exceed the global budget are `excluded` with a decision record.
6. Per-document chunk cap: `ceil(globalItemCap / 2)`, minimum 1. Prevents a single document from consuming more than half the global budget.
7. Optional minimum canonical floor: `contextBudget.minCanonicalItems` reserves slots for the top-ranked canonical candidates. They bypass the global budget check if configured.

### Reason codes

| Reason | Status | Meaning |
|---|---|---|
| `included.cross_layer_top_rank` | included | Top-ranked in global competition |
| `included.high_authority` | included (co-emitted) | Candidate has canonical authority tier |
| `excluded.cross_layer_budget_exceeded` | excluded / latent | Global item or token budget exhausted |
| `excluded.outcompeted_by_higher_rank` | latent (co-emitted) | Per-document cap hit (higher-ranked chunk took slot) |
| `excluded.per_document_cap` | latent (co-emitted) | Per-document chunk cap enforced |
| `overflow.to_latent` | latent (co-emitted) | Evidence item moved to latent class |

---

## Latent Memory Handling

Overflow retrieval results that do not fit within the policy budget are classified as `selectionClass: 'latent'` and included in `ContextAssemblyResult.items`. They are never silently discarded.

Latent items:

- Preserve full citation/provenance metadata from retrieval
- Preserve ranked order (lower-ranked items become latent first)
- Can be promoted in future passes or used for follow-up retrieval
- Are reflected in `itemCountByClass.latent`
- Trigger a warning in `ContextAssemblyResult.warnings`
- Appear in `renderPromptBlocks()` output as `[LATENT MEMORY SUMMARY]`

This is intentional: overflow evidence is retained structurally so that downstream consumers (graph expansion, follow-up retrieval, audit) can access it without re-running retrieval.

---

## Citation and Provenance

All citation/provenance fields from `NormalizedSearchResult` are preserved into `ContextAssemblyItem.metadata`:

- `title`, `uri`, `sourcePath`, `providerId`, `externalId`, `contentHash`
- `chunkId`, `documentId`, `charStart`, `charEnd`, `sectionLabel`, `pageNumber`
- `citationLabel`, `displayDomain`, `fetchedAt`
- `rank` (position in retrieval result list after provider fusion/ranking)

Content selection prefers `metadata.chunkContent` (the full chunk text) over `snippet` (a short excerpt). This ensures that chunk-aware providers (e.g., `SemanticSearchProvider`) contribute their full chunk to context rather than a truncated snippet.

Graph_context items derived by `GraphTraversalService` also carry provenance in their metadata:

- `graphNodeType`, `anchorCount`, `anchorKeys`, `documentId`, `derivedFrom`, `hopDepth`

Affective graph_context items carry affective metadata:

- `affective: true`, `affectiveNodeType` (`astro_state` | `emotion_tag`), `moodLabel`, `emotionalVector`, `rawAstroState`

---

## IPC and Preload Surface

### IPC Handler

```
channel: 'context:assemble'
input:   ContextAssemblyRequest
output:  { ok: true, result: ContextAssemblyResult } | { ok: false, error: string }
```

Registered in `electron/services/IpcRouter.ts`. Uses `getRetrievalOrchestrator()` (singleton) and constructs `MemoryPolicyService`, `GraphTraversalService`, and `ContextAssemblyService` on each call (stateless). `AffectiveGraphService` is passed as the optional 4th constructor argument using the `AstroService` instance obtained from `agent.getAstroService()`. If the Astro runtime is unavailable, not yet ignited, or throws during construction, `null` is passed instead and assembly continues without affective items — no crash, no change to evidence or structural graph context.

### Preload

```typescript
window.tala.contextAssemble(request: ContextAssemblyRequest): Promise<{ ok: boolean; result?: ContextAssemblyResult; error?: string }>
```

Exposed in `electron/preload.ts`. Policy logic stays in the main process — the renderer must not evaluate policy.

---

## Prompt Block Rendering

`ContextAssemblyService.renderPromptBlocks(result)` produces a deterministic, stable prompt string from a `ContextAssemblyResult`.

Sections:

| Section | Condition |
|---|---|
| `[PRIMARY EVIDENCE]` | Always present when evidence items exist |
| `[DIRECT GRAPH CONTEXT]` | Only when non-affective graph_context items exist |
| `[AFFECTIVE CONTEXT]` | Only when affective graph_context items exist (`metadata.affective === true`) |
| `[POLICY CONSTRAINTS]` | Always present; summarizes groundingMode, retrievalMode, scope, affectiveModulation status |
| `[LATENT MEMORY SUMMARY]` | Only when latent items were retained |

The `[AFFECTIVE CONTEXT]` section includes a footer note: *"These signals may influence tone or graph-context emphasis, but do not change factual grounding."* This makes the non-authoritative nature explicit in every rendered prompt.

The `[DIRECT GRAPH CONTEXT]` section shows only structural (non-affective) graph_context items. Affective items are always separated into their own section to prevent them from being mistaken for evidence-backed structural context.

The renderer is intentionally simple — no summarization, no inference. It formats what the assembler selected.

---

## Files

| File | Role |
|---|---|
| `shared/policy/memoryPolicyTypes.ts` | Canonical type contracts (policy, request, result, items) |
| `shared/retrieval/retrievalTypes.ts` | Retrieval contracts (re-exported into policy layer) |
| `electron/services/policy/defaultMemoryPolicies.ts` | Three baseline MemoryPolicy objects (including affectiveModulation defaults) |
| `electron/services/policy/MemoryPolicyService.ts` | Policy resolution and override merging |
| `electron/services/graph/GraphTraversalService.ts` | Graph traversal: evidence-seeded graph_context expansion |
| `electron/services/graph/AffectiveGraphService.ts` | Affective modulation: bounded, labeled affective graph_context from astro/emotional state |
| `electron/services/context/ContextAssemblyService.ts` | Assembly, budget enforcement, graph merging, rendering |
| `electron/services/IpcRouter.ts` | `context:assemble` IPC handler |
| `electron/preload.ts` | `window.tala.contextAssemble()` preload exposure |
| `tests/MemoryPolicyService.test.ts` | Policy resolution unit tests |
| `tests/ContextAssemblyService.test.ts` | Assembly, budget, citation, latent, affective integration tests |
| `tests/GraphTraversalService.test.ts` | Graph traversal: guards, derivation, filters, caps, integration |
| `tests/AffectiveGraphService.test.ts` | Affective gate conditions, item production, weight clamping, mode compatibility |
