# Research Collections Feature

## Overview

The Research Collections feature implements a PostgreSQL-backed layer for notebooks, search runs, and search run results. It replaces the previous in-memory/settings-only notebook state with a first-class persisted data model.

## Architecture

### Data Layer

Migration: `electron/migrations/008_research_collections.sql`

| Table | Purpose |
|---|---|
| `notebooks` | Named persistent collections of research items |
| `search_runs` | Records of executed searches with query metadata |
| `search_run_results` | Captured results from a specific search run |
| `notebook_items` | Items explicitly saved into a notebook (unique per notebook by `item_key`) |

### Repository

`electron/services/db/ResearchRepository.ts` — accepts a shared `pg.Pool` injected from `PostgresMemoryRepository.getSharedPool()`.

Initialized as a singleton in `electron/services/db/initMemoryStore.ts` alongside the canonical memory repository. Access via `getResearchRepository()`.

### IPC Layer

All operations are exposed via IPC handlers in `electron/services/IpcRouter.ts` under the `research:` prefix.

All handlers are exposed on `window.tala` via `electron/preload.ts` as `research*` methods.

| IPC Channel | Action |
|---|---|
| `research:listNotebooks` | List all notebooks |
| `research:createNotebook` | Create a new notebook |
| `research:getNotebook` | Get a notebook by id |
| `research:updateNotebook` | Update notebook metadata |
| `research:deleteNotebook` | Delete a notebook and its items |
| `research:listNotebookItems` | List items in a notebook |
| `research:addItemsToNotebook` | Add items to a notebook |
| `research:removeNotebookItem` | Remove a single item from a notebook |
| `research:removeNotebookItems` | Remove multiple items from a notebook in one operation |
| `research:createSearchRun` | Register a search run |
| `research:addSearchRunResults` | Store results for a search run |
| `research:getSearchRunResults` | Get results for a search run |
| `research:createNotebookFromSearchRun` | Create a notebook from all results in a search run |
| `research:addSearchRunResultsToNotebook` | Copy search run results into an existing notebook |
| `research:resolveNotebookScope` | Resolve notebook URIs and paths for retrieval scoping |

### UI Components

- `src/renderer/components/Notebooks.tsx` — Research sidebar and notebook viewer. Lists notebooks from PostgreSQL. Falls back to settings-based notebooks if the DB is unavailable. Each notebook item can be selected for agent context sync or future selective ingestion.
- `src/renderer/components/Search.tsx` — Search & Add panel. Creates a `search_run` on each search and registers all results in `search_run_results`. Shows per-result checkboxes for both local and web results with "SAVE SELECTED", "SAVE ALL", and "+ SCRAPE & ADD" actions.
- `src/renderer/utils/searchSelection.ts` — Pure TypeScript utilities (`resultKey`, `resultToNotebookItem`, `filterSelectedResults`, `allResultKeys`) that implement the curated save workflow. Testable without a DOM environment.

## Search & Add Workflow

### Curated Save (preferred) — no content ingestion

1. User types a query in Search & Add.
2. `researchCreateSearchRun({ query_text })` is called, creating a `search_runs` row.
3. Results are fetched via `RetrievalOrchestrator` (canonical) or legacy IPC fallback.
4. All results are registered in `search_run_results` via `researchAddSearchRunResults`.
5. User selects individual results using per-result checkboxes (both local files and web results).
6. User clicks **SAVE SELECTED** — selected results are saved as `notebook_items` references. No content scraping or ingestion occurs. All normalized metadata (itemKey, title, uri, sourcePath, snippet, providerId, externalId) is preserved.

### Select All / Clear Selection

- "Select All" button selects all current results at once.
- "Clear" button deselects all.
- Selection is automatically reset when a new search is run.

### Save All (convenience)

- When no items are selected, a "SAVE ALL" bar is shown.
- Copies all registered `search_run_results` for the current search into an existing or new notebook.
- Uses `researchAddSearchRunResultsToNotebook` or `researchCreateNotebookFromSearchRun`.

### Scrape & Add (explicit content download)

- Available alongside "SAVE SELECTED" when web results are selected.
- Downloads/scrapes the web page content locally before saving as a notebook item.
- Stores the local `source_path` alongside the notebook reference.
- This is an opt-in explicit step, not triggered automatically by selection.

## Curated Research Architecture

Search results, notebook items, and ingested content are three distinct layers:

| Layer | Table / Storage | Description |
|---|---|---|
| Search results | `search_run_results` | Ephemeral candidates from a query. Not memory by default. |
| Notebook items | `notebook_items` | Curated saved references. Curation gate for all downstream use. |
| Ingested content | `source_documents`, `document_chunks` | Full content available for retrieval. Created by explicit ingestion. |

Notebook membership is the curation gate. Ingestion is a separate explicit step.

## My Notebooks Sidebar

The "My Notebooks" section in the Research sidebar is populated by `researchListNotebooks()` which queries the `notebooks` PostgreSQL table. Notebooks persist across app restarts.

## Notebook Item Actions

Each notebook item card has a per-item **×** remove button (calls `researchRemoveNotebookItem`). Removing an item also removes it from the `activeSources` set immediately.

When one or more items are selected (checked), a **REMOVE SELECTED (N)** button appears in the items toolbar. Clicking it:
1. Bulk-removes all selected items from `notebook_items` via `researchRemoveNotebookItems` (single SQL `DELETE ... WHERE item_key = ANY(...)`)
2. If any selected items have a `source_path` (scraped/downloaded content), the user is prompted whether to also remove that content from the RAG store via `rag-delete` / `api.deleteMemory(path)`
3. RAG deletion failures are reported as a warning (items are still removed from the notebook)
4. `activeSources` is cleared after removal

## Retrieval Scoping (RAG Foundation)

`ResearchRepository.resolveNotebookScope(notebookId)` returns:
- `uris[]` — all web URIs in the notebook
- `sourcePaths[]` — all local file paths in the notebook
- `itemKeys[]` — all item keys

This scope is used by `UPDATE AGENT CONTEXT` to set `setActiveNotebookContext` with real source paths. It also provides the foundation for future pgvector-based semantic search constrained to notebook membership.

## Fallback Behavior

If the PostgreSQL database is unavailable (e.g., DB not started), the UI gracefully falls back to the legacy settings-based notebook list. Notebook creation also falls back to settings when the DB is unavailable.

## Schema Summary

```sql
notebooks (id, name, description, created_at, updated_at, is_dynamic, query_template, source_scope_json, tags_json)

search_runs (id, query_text, normalized_query, filters_json, source_scope_json, executed_at, executed_by, notebook_id)

search_run_results (id, search_run_id, item_key, item_type, source_id, source_path, title, uri, snippet, score, metadata_json, content_hash, captured_at)

notebook_items (id, notebook_id, item_key UNIQUE per notebook, item_type, source_id, source_path, title, uri, snippet, content_hash, added_from_search_run_id, added_at, metadata_json)
```
