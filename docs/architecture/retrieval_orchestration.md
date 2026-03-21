# Retrieval Orchestration Architecture

## Overview

TALA uses a layered retrieval architecture where all content discovery flows
through a single canonical orchestrator. This ensures consistent normalization,
provenance tracking, deduplication, and graceful degradation regardless of
whether results come from local workspace files or external API providers.

---

## Core Contracts

### `shared/retrieval/retrievalTypes.ts`

All retrieval contracts are pure TypeScript with no Node.js APIs, compiled
by both `electron/tsconfig.json` (main process) and `tsconfig.app.json`
(renderer/browser). Key types:

| Type | Purpose |
|------|---------|
| `SearchProvider` | Interface all providers must implement |
| `NormalizedSearchResult` | Single canonical result shape from any provider |
| `RetrievalRequest` | Input to `RetrievalOrchestrator.retrieve()` |
| `RetrievalResponse` | Merged, deduplicated output with diagnostics |
| `SearchProviderResult` | Per-provider raw results (preserved for attribution) |
| `RetrievalMode` | `'keyword' \| 'semantic' \| 'hybrid' \| 'graph'` |
| `RetrievalScopeType` | `'global' \| 'notebook' \| 'explicit_sources'` |

---

## Provider Roles

### Local vs External — Discovery vs Storage

```
External Provider (ExternalApiSearchProvider)
    → discovery source only
    → results are ephemeral
    → never become canonical memory automatically

Local Provider (LocalSearchProvider)
    → wraps FileService.searchFiles()
    → searches workspace files by content
    → results backed by the actual file system

PostgreSQL (ResearchRepository)
    → truth layer for notebooks and research collections
    → notebook_items are always saved locally regardless of result origin
    → search_runs and search_run_results track all retrieval activity
```

**Key rule**: External search providers are discovery tools. Their results
are presented for evaluation and must be explicitly saved to a notebook by
the user. They never automatically populate canonical memory.

---

## Provider Implementations

### `LocalSearchProvider`
**File**: `electron/services/retrieval/providers/LocalSearchProvider.ts`

- Wraps `FileService.searchFiles()` (existing local content search)
- `providerId`: `'local'`
- `supportedModes`: `['keyword']`
- Stable `itemKey`: `'local:<relativePath>'`
- Fails gracefully — exceptions are returned as `SearchProviderResult.error`

**NormalizedSearchResult mapping**:
```
FileService result    → NormalizedSearchResult
──────────────────────────────────────────────
path                  → sourcePath, title, itemKey ('local:<path>')
content               → snippet
—                     → uri (null)
—                     → score (null)
'local_file'          → sourceType
```

### `ExternalApiSearchProvider`
**File**: `electron/services/retrieval/providers/ExternalApiSearchProvider.ts`

- Reads active search provider from `AppSettings.search` (Settings → Search tab)
- `providerId`: `'external:<settingsProviderId>'`  e.g. `'external:brave-main'`
- `supportedModes`: `['keyword']`
- Supports all `SearchProvider.type` values defined in `shared/settings.ts`:
  `google` / `serper`, `brave`, `tavily`, `custom`, `rest`

**Per-type adapters**:

| Type | Endpoint default | Request method | Response field |
|------|-----------------|---------------|---------------|
| `serper` / `google` | `https://google.serper.dev/search` | POST | `organic[].{title,link,snippet}` |
| `brave` | `https://api.search.brave.com/res/v1/web/search` | GET | `web.results[].{title,url,description}` |
| `tavily` | `https://api.tavily.com/search` | POST | `results[].{title,url,content,score}` |
| `custom` / `rest` | configurable | GET (`?q=`) | generic array or `{results,items,data}` |

**Failure modes**:
- No active provider configured → returns `error` field, no throw
- Provider disabled → returns `error` field, no throw
- Network error / timeout → returns `error` field, no throw
- All errors surface as `RetrievalResponse.warnings[]` via the orchestrator

**Settings config shape** (`shared/settings.ts`):
```typescript
interface SearchConfig {
  activeProviderId: string;        // Must match a provider id
  providers: SearchProvider[];
}
interface SearchProvider {
  id: string;
  name: string;
  type: 'google' | 'brave' | 'serper' | 'tavily' | 'custom' | 'rest';
  endpoint?: string;               // Override default endpoint
  apiKey?: string;
  enabled: boolean;                // Provider must be enabled to be active
}
```

---

## RetrievalOrchestrator

**File**: `electron/services/retrieval/RetrievalOrchestrator.ts`

Central orchestration layer. Responsibilities:

1. Accept a `RetrievalRequest`
2. Resolve scope (global / notebook / explicit_sources) using `ResearchRepository`
3. Select providers by mode (all keyword providers, or filtered by `providerIds`)
4. Execute selected providers in parallel via `Promise.allSettled()`
5. Merge, deduplicate by `itemKey` (first occurrence wins), sort by score descending
6. Cap at `topK` if set
7. Return `RetrievalResponse` with merged results and per-provider diagnostics

**Provider selection**:
```typescript
// Use all keyword providers (default)
{ query: '...', mode: 'keyword', scope: 'global' }

// Local only
{ query: '...', mode: 'keyword', scope: 'global', providerIds: ['local'] }

// External only
{ query: '...', mode: 'keyword', scope: 'global', providerIds: ['external:brave-main'] }
```

---

## Registry and Initialization

**File**: `electron/services/retrieval/RetrievalOrchestratorRegistry.ts`

Manages the singleton `RetrievalOrchestrator` and provider wiring.

**Startup flow** (wired in `electron/main.ts`):
```
initCanonicalMemory()
    ↓
initRetrievalOrchestrator({
    fileService,
    researchRepo,   // from getResearchRepository()
    settingsPath,   // SETTINGS_PATH
})
    ↓ reads settings.search.providers
    ↓ registers LocalSearchProvider
    ↓ registers ExternalApiSearchProvider (if active enabled provider exists)
```

**Settings refresh** (via IPC `retrieval:refreshExternalProvider`):
```
User applies Settings → renderer calls tala.retrievalRefreshExternalProvider()
    → IpcRouter calls refreshExternalProvider(settingsPath)
    → unregisters old external:* providers
    → registers new ExternalApiSearchProvider if config valid
```

> **TODO (refresh-on-settings-apply)**: The refresh IPC handler is exposed
> but the Settings UI does not yet auto-call it on apply. Wire
> `tala.retrievalRefreshExternalProvider()` into the Settings save handler
> for automatic pickup on settings change.

---

## IPC API (renderer ↔ main)

**Registered in**: `electron/services/IpcRouter.ts`
**Exposed via**: `electron/preload.ts` as `window.tala.*`

| IPC channel | Preload method | Purpose |
|-------------|---------------|---------|
| `retrieval:retrieve` | `tala.retrievalRetrieve(request)` | Execute retrieval via orchestrator |
| `retrieval:listProviders` | `tala.retrievalListProviders()` | List registered providers |
| `retrieval:refreshExternalProvider` | `tala.retrievalRefreshExternalProvider()` | Refresh external provider from settings |

**Request shape**:
```typescript
tala.retrievalRetrieve({
  query: 'search term',
  mode: 'keyword',
  scope: 'global',           // or 'notebook' / 'explicit_sources'
  notebookId?: 'nb-uuid',   // required when scope='notebook'
  providerIds?: ['local'],   // omit for all providers
  topK?: 10,
})
```

**Response shape**: `{ ok: true, response: RetrievalResponse }` or `{ ok: false, error: string }`

---

## Search UI Integration

**File**: `src/renderer/components/Search.tsx`

The Search component now routes through `tala.retrievalRetrieve()`:

```
User submits query
    ↓
tala.retrievalRetrieve({ query, mode: 'keyword', scope: 'global',
                         providerIds: mode==='local' ? ['local'] : undefined })
    ↓
RetrievalOrchestrator selects matching providers
    ↓ LocalSearchProvider (file system)
    ↓ ExternalApiSearchProvider (settings-configured external API)
    ↓ merges + deduplicates results
    ↓
NormalizedSearchResult[] → mapped to Result[] for display
    ↓
tala.researchCreateSearchRun() + researchAddSearchRunResults()  [PostgreSQL]
    ↓
User selects results → ADD TO NOTEBOOK → researchAddItemsToNotebook() [PostgreSQL]
```

**Legacy fallback**: If `tala.retrievalRetrieve` is unavailable (e.g., old
Electron build), the component falls back to the original `searchFiles` /
`searchRemote` IPC paths. This fallback will be removed in a future cleanup pass.

**Provenance display**: Each result card shows a `providerId` badge for
external results (e.g., `external:brave-main`), allowing users to see
which provider produced each result.

---

## Notebooks and Research Collections

### Discovery vs Membership

TALA distinguishes two search behaviors for notebooks:

| Behavior | Description |
|----------|-------------|
| **Content research** | Search for new material to add (uses RetrievalOrchestrator, global scope) |
| **Membership search** | Search within items already in a notebook (uses `scope='notebook'`, `notebookId`) |

### Notebook membership is always local PostgreSQL

Regardless of whether a result was discovered via local or external provider,
saving to a notebook stores the item in `notebook_items` in PostgreSQL.
External results never auto-populate notebook membership.

### Provenance fields in `notebook_items`

When saving search results to a notebook, the following fields are preserved:

```
item_key      → canonical key (uri or path-based)
item_type     → 'web' or 'local_file'
uri           → canonical URL if external
source_path   → file-system path if local
snippet       → short excerpt
provider_id   → originating provider id
```

---

## Retrieval Pipeline (canonical flow)

```
retrieve from providers (local + external)
    ↓ normalize → NormalizedSearchResult[]
    ↓ merge + dedup by itemKey
    ↓ sort by score
    ↓ cap at topK
    ↓
render results in Search UI
    ↓
create search_run record in PostgreSQL
    ↓
register search_run_results in PostgreSQL
    ↓
[optional] user selects results
    ↓
save to notebook_items in PostgreSQL
```

**External providers cannot bypass this pipeline.** All results go through
normalization before being rendered or persisted.

---

## Future Integration Paths

### pgvector semantic provider

When pgvector is enabled and embeddings are populated, a future
`SemanticSearchProvider` can be registered alongside `LocalSearchProvider`
and `ExternalApiSearchProvider` without changing the orchestrator or the
Search UI. It will support `mode: 'semantic'` and `mode: 'hybrid'`.

```typescript
class SemanticSearchProvider implements SearchProvider {
  id = 'semantic_pgvector';
  supportedModes: RetrievalMode[] = ['semantic', 'hybrid'];
  // ... uses PostgresMemoryRepository.searchObservationsBySimilarity()
}
```

### Notebook content ingestion for semantic search

Future: when a notebook item is saved, trigger embedding generation and
store the vector in `observation_embeddings`. The `SemanticSearchProvider`
can then search within notebook scope using pgvector similarity.

### Additional external provider types

Add a new response adapter function (e.g., `adaptPerplexityResponse`) and
extend the `_executeSearch` switch in `ExternalApiSearchProvider`. The
settings `SearchProvider.type` union should be extended in `shared/settings.ts`
to include the new type.

### Refresh-on-settings-apply

Wire `tala.retrievalRefreshExternalProvider()` into the Settings panel save
handler. This will allow the external provider to pick up configuration
changes at runtime without requiring an app restart.

---

## Architectural Rules

1. **PostgreSQL is the truth layer** — notebooks, search runs, and search
   results are stored in PostgreSQL regardless of provider origin.

2. **Notebooks are curated local collections** — not mirrors of external provider
   state. External results that users choose to save become local records.

3. **External providers are discovery sources only** — they never auto-populate
   canonical memory, notebooks, or observations.

4. **All providers normalize into the same shape** — `NormalizedSearchResult`
   is the single contract. Provider-specific metadata is preserved in the
   `metadata` blob.

5. **Graceful degradation** — provider failures emit warnings but do not crash
   the UI or the retrieval call. Other providers continue to serve results.

6. **No UI-owned provider logic** — the renderer submits `RetrievalRequest` via
   IPC. Provider selection, execution, merging, and deduplication happen in the
   main process only.
