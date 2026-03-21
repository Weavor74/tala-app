# AffectiveGraphService — Interface Contract

## Overview

`AffectiveGraphService` (file: `electron/services/graph/AffectiveGraphService.ts`) is the backend service responsible for translating the current astro/emotional state into bounded, labeled `graph_context` ContextAssemblyItems.

This document specifies:
- The `AstroServiceSeam` interface used for dependency injection
- The `GetActiveAffectiveContextArgs` input contract
- The `RawEmotionalState` shape consumed from AstroService
- The contract for items returned by `getActiveAffectiveContext()`

All interfaces are defined in `electron/services/graph/AffectiveGraphService.ts`. They are Node.js-only; do not import from renderer code.

---

## AstroServiceSeam

```typescript
interface AstroServiceSeam {
  getReadyStatus(): boolean;
  getEmotionalState(agentId?: string, contextPrompt?: string): Promise<string>;
  getRawEmotionalState(agentId?: string): Promise<RawEmotionalState | null>;
}
```

`AstroService` (file: `electron/services/AstroService.ts`) satisfies this interface. The seam exists to:

- Enable testing without a live Astro Engine process
- Allow `AffectiveGraphService` to be constructed before `AstroService` is ready (pass `null`; the service degrades gracefully)

### Method contracts

| Method | Return on success | Return on failure / unavailable |
|---|---|---|
| `getReadyStatus()` | `true` when MCP client is connected | `false` |
| `getEmotionalState(agentId?, contextPrompt?)` | Formatted `[ASTRO STATE]` block string | Neutral/error sentinel string |
| `getRawEmotionalState(agentId?)` | `RawEmotionalState` object | `null` |

`AffectiveGraphService` treats the following return values from `getEmotionalState()` as "unavailable" and returns an empty array:
- Empty string
- String containing `engine offline`
- String containing `neutral (engine`
- String containing `not ready`
- String containing `calculation failed`
- String containing `calculation returned no data`

---

## RawEmotionalState

```typescript
interface RawEmotionalState {
  mood_label?: string;
  emotional_vector?: {
    warmth?: number;
    intensity?: number;
    clarity?: number;
    caution?: number;
  };
  [key: string]: unknown;  // additional fields preserved in metadata
}
```

`mood_label` is used to produce the `emotion_tag` ContextAssemblyItem. When absent or empty, no `emotion_tag` item is produced.

`emotional_vector` is preserved in the `emotion_tag` item's `metadata.emotionalVector` for downstream diagnostics. It does not affect item scoring.

---

## GetActiveAffectiveContextArgs

```typescript
interface GetActiveAffectiveContextArgs {
  policy: MemoryPolicy;
  notebookId?: string | null;
  queryText?: string;
  agentId?: string;
}
```

| Field | Required | Notes |
|---|---|---|
| `policy` | Yes | Resolved `MemoryPolicy` governing this assembly pass. Must include `affectiveModulation` for modulation to be active; absent defaults to disabled. |
| `notebookId` | No | Notebook context for sourceKey scoping. Does not change evidence retrieval scope. |
| `queryText` | No | Passed as `contextPrompt` to `AstroService.getEmotionalState()` to allow engine fine-tuning. |
| `agentId` | No | Agent profile ID passed to AstroService. Defaults to `'tala'`. |

---

## getActiveAffectiveContext() Return Contract

```typescript
getActiveAffectiveContext(args: GetActiveAffectiveContextArgs): Promise<ContextAssemblyItem[]>
```

**Never throws.** All internal errors are caught and result in an empty array being returned.

### Returned item guarantees

Every item in the returned array satisfies:

| Property | Guaranteed value |
|---|---|
| `selectionClass` | `'graph_context'` — never `'evidence'` |
| `graphEdgeType` | `'modulates'` |
| `graphEdgeTrust` | `'session_only'` |
| `metadata.affective` | `true` |
| Content prefix (when `requireLabeling: true`) | `'[Affective context — not evidence]\n'` |

### Returned item types

| `sourceType` | `metadata.affectiveNodeType` | Produced when |
|---|---|---|
| `astro_state` | `astro_state` | Astro state text is non-neutral and non-empty |
| `emotion_tag` | `emotion_tag` | `rawState.mood_label` is a non-empty string |

### Score values

| Item | Score |
|---|---|
| `astro_state` | `min(policy.affectiveModulation.affectiveWeight, 0.3)` |
| `emotion_tag` | `min(policy.affectiveModulation.affectiveWeight, 0.3) × 0.8` |

Scores are always at or below 0.3 regardless of the configured `affectiveWeight`, enforced by an internal clamp. This prevents affective items from outranking evidence items via score-based sorting.

### Content truncation

`astro_state` item content (after stripping the `[ASTRO STATE]` header) is truncated to 400 characters, with `…` appended when the source text exceeds that length. This prevents token-budget exhaustion from verbose engine responses. The disclaimer prefix (`[Affective context — not evidence]\n`) is added after truncation.

### Array length

The returned array contains at most `policy.affectiveModulation.maxAffectiveNodes` items, enforced by a `slice()` cap.

### Empty array conditions

Returns `[]` when any of the following are true:
1. `policy.groundingMode === 'strict'`
2. `policy.affectiveModulation` is absent or `enabled === false`
3. `policy.affectiveModulation.maxAffectiveNodes === 0`
4. `astroService` constructor argument was `null`
5. `astroService.getReadyStatus()` returns `false`
6. `astroService.getEmotionalState()` throws
7. Returned state text matches a neutral/offline sentinel

---

## AffectiveModulationPolicy (in MemoryPolicy)

The policy field governing this service's behavior:

```typescript
interface AffectiveModulationPolicy {
  enabled: boolean;
  maxAffectiveNodes: number;
  allowToneModulation: boolean;
  allowGraphOrderingInfluence: boolean;
  allowGraphExpansionInfluence: boolean;
  allowEvidenceReordering: boolean;   // must remain false in all default policies
  affectiveWeight: number;            // clamped to 0.3 by the service
  requireLabeling: boolean;           // true by default; controls disclaimer prefix
}
```

Attached as the optional `affectiveModulation` field on `MemoryPolicy` (defined in `shared/policy/memoryPolicyTypes.ts`). When absent, the service treats it as fully disabled.

Policy is resolved by `MemoryPolicyService.resolvePolicy()` which merges caller overrides over the base policy defaults from `defaultMemoryPolicies.ts`.

---

## Related Files

| File | Role |
|---|---|
| `electron/services/graph/AffectiveGraphService.ts` | Implementation and interface definitions |
| `electron/services/AstroService.ts` | Concrete `AstroServiceSeam` implementation |
| `shared/policy/memoryPolicyTypes.ts` | `AffectiveModulationPolicy`, affective node/edge types |
| `electron/services/policy/defaultMemoryPolicies.ts` | Default affective policy values |
| `electron/services/policy/MemoryPolicyService.ts` | Policy resolution and merging |
| `docs/architecture/affective_graph_modulation.md` | Architecture overview for this subsystem |
