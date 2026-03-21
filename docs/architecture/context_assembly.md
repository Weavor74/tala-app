# Context Assembly — Architecture

## Purpose

`ContextAssemblyService` is the first runtime implementation of the TALA context assembly layer (Step 5B). Its job is to transform retrieval results into policy-governed, prompt-ready context that can be injected into an LLM turn.

Before this service existed, the retrieval and prompt assembly layers were loosely coupled through ad-hoc logic in `TalaContextRouter` and `ContextAssembler`. `ContextAssemblyService` provides a clean seam: retrieval produces candidates, policy decides what enters context, and the assembler formats the result.

---

## Relationship Between Retrieval, Policy, and Context Assembly

```
ContextAssemblyRequest
  │
  ├─► MemoryPolicyService.resolvePolicy()
  │     └─► selects base policy from defaultMemoryPolicies.ts
  │         merges caller overrides
  │         derives scope (notebook/global from notebookId)
  │         returns resolved MemoryPolicy
  │
  └─► ContextAssemblyService.assemble()
        │
        ├─► RetrievalOrchestrator.retrieve()   ← existing layer, unchanged
        │     uses policy.retrievalMode + policy.scope
        │
        ├─► _mapResultToItem()                 ← preserves all citation/provenance
        │
        ├─► _selectItems()                     ← enforces budget, produces latent overflow
        │
        └─► ContextAssemblyResult
              items: ContextAssemblyItem[]     ← evidence + latent
              policy: MemoryPolicy
              itemCountByClass
              estimatedTokens
              durationMs
              warnings
```

The three layers are kept strictly separate:

| Layer | File | Responsibility |
|---|---|---|
| Retrieval | `RetrievalOrchestrator.ts` | Fetch, merge, deduplicate candidates |
| Policy | `MemoryPolicyService.ts` | Resolve active policy from request |
| Assembly | `ContextAssemblyService.ts` | Select, classify, budget, format |

Policy does not call retrieval. Retrieval does not know about policy. The assembler is the only layer that calls both.

---

## Evidence-First Grounding

All context assembly passes enforce evidence-first grounding:

- Evidence items (retrieved documents, chunks, notebook items) are always selected before any other class.
- `contextBudget.evidencePriority = true` in all three default policies.
- In `strict` mode, only evidence items enter context. No graph context, no latent items injected.
- In `graph_assisted` and `exploratory` modes, evidence still fills its budget first. Graph context (empty in this pass) and latent overflow follow.

This prevents the model from drawing on unsupported context when real evidence exists.

---

## Grounding Modes

Three grounding modes are defined in `shared/policy/memoryPolicyTypes.ts` and implemented via default policies in `electron/services/policy/defaultMemoryPolicies.ts`:

### `strict`

- `graphTraversal.enabled = false`
- No graph context items added (graph_context budget = 0)
- Conservative budgets: `maxItems: 10`, `maxTokens: 4096`
- Use when the model must be grounded only in retrieved evidence

### `graph_assisted`

- `graphTraversal.enabled = true`, `maxHopDepth: 1`
- Graph context section is structurally supported but empty until graph runtime exists
- Moderate budgets: `maxItems: 15`, `maxTokens: 6144`
- Default when no groundingMode is specified

### `exploratory`

- `graphTraversal.enabled = true`, `maxHopDepth: 2`
- More permissive traversal settings (`minEdgeTrustLevel: inferred_low`)
- Larger budgets: `maxItems: 20`, `maxTokens: 8192`
- Use for broad context passes where evidence is preferred but not mandatory

---

## Budget Enforcement

`ContextAssemblyService._selectItems()` applies the following rules in order:

1. Evidence items are selected first (evidencePriority enforced).
2. Total injected item count is capped by `contextBudget.maxItems`.
3. Evidence class cap is applied from `contextBudget.maxItemsPerClass.evidence` when set.
4. Per-document chunk cap: `ceil(evidenceCap / 2)`, minimum 1. Prevents a single document from consuming the entire evidence budget.

All items that do not fit within the budget become `latent` items (not dropped).

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

---

## Why `graph_context` Is Structurally Supported but Empty

The `ContextAssemblyResult.items` structure includes `MemorySelectionClass: 'graph_context'` as a valid classification, and all three grounding modes have `graphTraversal` settings configured. However:

- The graph runtime (`tala-memory-graph`) is not called in this pass.
- No graph nodes are fabricated.
- The `graph_context` budget slots exist but are never filled.

This is intentional. The structural support for graph context items was put in place in Step 5B so that when the graph runtime is available, graph node injection requires only:

1. A graph traversal call after retrieval (using `policy.graphTraversal`)
2. Mapping graph nodes to `ContextAssemblyItem` with `selectionClass: 'graph_context'`
3. Inserting them into the assembly result before budget enforcement

The assembler, renderer, and IPC surface require no changes.

---

## IPC and Preload Surface

### IPC Handler

```
channel: 'context:assemble'
input:   ContextAssemblyRequest
output:  { ok: true, result: ContextAssemblyResult } | { ok: false, error: string }
```

Registered in `electron/services/IpcRouter.ts`. Uses `getRetrievalOrchestrator()` (singleton) and constructs `MemoryPolicyService` and `ContextAssemblyService` on each call (stateless).

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
| `[DIRECT GRAPH CONTEXT]` | Only when graph_context items exist (empty in this pass) |
| `[POLICY CONSTRAINTS]` | Always present; summarizes groundingMode, retrievalMode, scope |
| `[LATENT MEMORY SUMMARY]` | Only when latent items were retained |

The renderer is intentionally simple — no summarization, no inference. It formats what the assembler selected.

---

## Future Graph Integration Hooks

The following seams are in place for future graph runtime integration:

1. **`policy.graphTraversal`** — fully specified in all default policies; ready to be passed to a graph traversal engine.
2. **`ContextAssemblyItem.graphEdgeType` / `.graphEdgeTrust`** — fields are present and typed; graph traversal output can populate them directly.
3. **`contextBudget.maxItemsPerClass.graph_context`** — budget slot exists and is respected by `_selectItems()`; graph items will honor it once injected.
4. **`[DIRECT GRAPH CONTEXT]` section** — rendered when graph items are present; no renderer changes needed.
5. **`latentItems` carry-forward** — overflow from this pass can serve as seed nodes for graph traversal in a follow-up pass.

When the graph runtime is available, the integration point is:

```
After step 3 (map retrieval → evidence candidates)
Insert step 3b: traverse graph from evidence seeds → produce graph_context candidates
Then continue to step 4 (budget enforcement)
```

No existing code paths need to change.

---

## Files

| File | Role |
|---|---|
| `shared/policy/memoryPolicyTypes.ts` | Canonical type contracts (policy, request, result, items) |
| `shared/retrieval/retrievalTypes.ts` | Retrieval contracts (re-exported into policy layer) |
| `electron/services/policy/defaultMemoryPolicies.ts` | Three baseline MemoryPolicy objects |
| `electron/services/policy/MemoryPolicyService.ts` | Policy resolution and override merging |
| `electron/services/context/ContextAssemblyService.ts` | Assembly, budget enforcement, rendering |
| `electron/services/IpcRouter.ts` | `context:assemble` IPC handler |
| `electron/preload.ts` | `window.tala.contextAssemble()` preload exposure |
| `tests/MemoryPolicyService.test.ts` | Policy resolution unit tests |
| `tests/ContextAssemblyService.test.ts` | Assembly, budget, citation, latent tests |
