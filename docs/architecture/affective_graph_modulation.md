# Affective Graph Modulation — Architecture

## Purpose

`AffectiveGraphService` is the first affective graph modulation layer for the TALA context assembly pipeline. Its job is to translate the current astro/emotional state (produced by `AstroService`) into bounded, labeled `graph_context` items that can supplement—but never override—primary evidence in an assembled context block.

Affective modulation is a modulatory layer only. It adjusts graph_context ordering and tone descriptors; it never changes which evidence items are retrieved, selected, or ranked.

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
        ├─► AffectiveGraphService.getActiveAffectiveContext()  ← affective graph_context
        │     reads policy.affectiveModulation
        │     calls AstroService.getEmotionalState()
        │     returns bounded, labeled graph_context items
        │     (empty in strict mode, or when disabled, or when astro unavailable)
        │
        ├─► _selectItems()                                ← evidence budget enforcement
        │
        └─► ContextAssemblyResult
              items: ContextAssemblyItem[]  ← evidence + graph_context + latent
```

`AffectiveGraphService` is called after `GraphTraversalService` and before final budget enforcement. Its items enter the same `graph_context` budget slot as structural traversal items. They are never placed in the `evidence` slot.

---

## Policy Governance

Affective modulation is gated by `AffectiveModulationPolicy` (defined in `shared/policy/memoryPolicyTypes.ts`) attached to each `MemoryPolicy` as the optional `affectiveModulation` field.

### Policy Fields

| Field | Type | Purpose |
|---|---|---|
| `enabled` | boolean | Master on/off switch for this assembly pass |
| `maxAffectiveNodes` | number | Hard cap on affective items returned |
| `allowToneModulation` | boolean | Permit tone descriptor in affective item content |
| `allowGraphOrderingInfluence` | boolean | Permit affective items to influence graph_context sort order |
| `allowGraphExpansionInfluence` | boolean | Permit affective state to trigger additional graph_context expansion |
| `allowEvidenceReordering` | boolean | Permit reordering of evidence items (must remain false by default) |
| `affectiveWeight` | number [0, 1] | Scalar applied as the score on affective items; clamped to 0.3 max |
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

The service degrades gracefully at each gate without throwing.

---

## Item Production

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

The 400-character limit prevents token-budget exhaustion from verbose engine responses while still surfacing the most relevant emotional state data.

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

## Critical Constraints

- Affective items are **never evidence**. `selectionClass` is always `graph_context`.
- Affective items **never override retrieved evidence** or change evidence ranking.
- Affective content is **never fabricated** when no astro/emotion state is present.
- `affectiveWeight` is **clamped to 0.3** by the service regardless of policy value.
- `allowEvidenceReordering` is **false** in all default policies and must remain so unless explicitly enabled by a caller with a clear documented reason.
- Strict mode **always returns empty** regardless of policy flags.
- `requireLabeling: true` is the default and must only be set false in contexts with explicit user consent.

---

## Runtime Seam

`AffectiveGraphService` accepts its `AstroService` dependency via constructor injection as an `AstroServiceSeam` interface (defined in `AffectiveGraphService.ts`). This:

- Allows testing without a live Astro Engine process.
- Allows the service to be instantiated before `AstroService` is ready (pass `null`; service degrades gracefully).
- Prevents `AffectiveGraphService` from importing Electron-specific code directly.

---

## Source Files

| File | Role |
|---|---|
| `electron/services/graph/AffectiveGraphService.ts` | Service implementation |
| `shared/policy/memoryPolicyTypes.ts` | `AffectiveModulationPolicy`, `GraphNodeType` (astro_state, emotion_tag, affect_state), `GraphEdgeType` (modulates, amplifies, suppresses, resonates_with, active_during) |
| `electron/services/policy/defaultMemoryPolicies.ts` | Default `affectiveModulation` values per grounding mode |
| `electron/services/policy/MemoryPolicyService.ts` | Merges `affectiveModulation` overrides during policy resolution |
| `tests/AffectiveGraphService.test.ts` | 37 unit tests |
