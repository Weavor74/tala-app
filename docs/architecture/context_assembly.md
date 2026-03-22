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
        ├─► _mergeGraphContextItems()                    ← ordering + combined graph_context cap
        │     merges structural + affective graph_context candidates
        │     if allowGraphOrderingInfluence=false: affective items placed first, structural unchanged
        │     if allowGraphOrderingInfluence=true: structural items receive small keyword-overlap boost
        │     evidence ordering is NEVER affected by this step
        │     combined list capped by contextBudget.maxItemsPerClass.graph_context
        │
        ├─► _selectItems()                               ← enforces evidence budget
        │     applies maxItems / maxItemsPerClass.evidence / per-doc chunk cap
        │     overflow evidence moves to 'latent' (never dropped)
        │
        └─► ContextAssemblyResult
              items: ContextAssemblyItem[]     ← evidence + graph_context + latent
              policy: MemoryPolicy
              itemCountByClass
              estimatedTokens
              durationMs
              warnings
```

The assembly layers are kept strictly separate:

| Layer | File | Responsibility |
|---|---|---|
| Retrieval | `RetrievalOrchestrator.ts` | Fetch, merge, deduplicate candidates |
| Policy | `MemoryPolicyService.ts` | Resolve active policy from request (including affectiveModulation) |
| Graph Traversal | `GraphTraversalService.ts` | Expand evidence seeds into structural graph_context candidates |
| Affective Modulation | `AffectiveGraphService.ts` | Produce bounded, labeled affective graph_context from astro/emotional state |
| Assembly | `ContextAssemblyService.ts` | Select, classify, budget, format |

Policy does not call retrieval. Retrieval does not know about policy. Graph traversal receives only evidence items and policy — it does not call retrieval. Affective modulation receives only policy and query text — it does not access evidence items. The assembler is the only layer that calls all others.

---

## Evidence-First Grounding

All context assembly passes enforce evidence-first grounding:

- Evidence items (retrieved documents, chunks, notebook items) are always selected before any other class.
- `contextBudget.evidencePriority = true` in all three default policies.
- In `strict` mode, only evidence items enter context. Graph traversal is skipped, affective modulation is skipped, and no graph_context items are added.
- In `graph_assisted` and `exploratory` modes, evidence fills its budget first. Graph context (from `GraphTraversalService` and `AffectiveGraphService`) and latent overflow follow.
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

The combined graph_context list (structural + affective) is then capped by `contextBudget.maxItemsPerClass.graph_context`. This cap applies to all graph_context items together, not separately per source.

### Graceful degradation

If `AffectiveGraphService.getActiveAffectiveContext()` throws, the exception is caught, a warning is added to `ContextAssemblyResult.warnings`, and assembly continues with an empty affective item list. The rest of the pipeline is unaffected.

See: `docs/architecture/affective_graph_modulation.md` for full gate conditions and item production rules.

---

## Budget Enforcement

`ContextAssemblyService._selectItems()` applies the following rules in order for evidence:

1. Evidence items are selected first (evidencePriority enforced).
2. Total injected item count is capped by `contextBudget.maxItems`.
3. Evidence class cap is applied from `contextBudget.maxItemsPerClass.evidence` when set.
4. Per-document chunk cap: `ceil(evidenceCap / 2)`, minimum 1. Prevents a single document from consuming the entire evidence budget.

Graph context items (structural + affective combined) are capped separately using `contextBudget.maxItemsPerClass.graph_context` before being merged into the result. They are not subject to the evidence budget rules.

All items that do not fit within the evidence budget become `latent` items (not dropped).

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
