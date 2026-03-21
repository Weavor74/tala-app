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
| `research:removeNotebookItem` | Remove an item from a notebook |
| `research:createSearchRun` | Register a search run |
| `research:addSearchRunResults` | Store results for a search run |
| `research:getSearchRunResults` | Get results for a search run |
| `research:createNotebookFromSearchRun` | Create a notebook from all results in a search run |
| `research:addSearchRunResultsToNotebook` | Copy search run results into an existing notebook |
| `research:resolveNotebookScope` | Resolve notebook URIs and paths for retrieval scoping |

### UI Components

- `src/renderer/components/Notebooks.tsx` — Research sidebar and notebook viewer. Lists notebooks from PostgreSQL. Falls back to settings-based notebooks if the DB is unavailable.
- `src/renderer/components/Search.tsx` — Search & Add panel. Creates a `search_run` on each search and registers all results in `search_run_results`. Shows "SAVE ALL" toolbar to copy results to a notebook.

## Search & Add Workflow

1. User types a query in Search & Add.
2. `researchCreateSearchRun({ query_text })` is called, creating a `search_runs` row.
3. Results are fetched via the existing `search-remote` or `search-local` IPC.
4. All results are registered in `search_run_results` via `researchAddSearchRunResults`.
5. User selects results and clicks "ADD TO NOTEBOOK" — selected URLs are scraped and added as `notebook_items`.
6. Or: user clicks "SAVE ALL" to copy all registered results into an existing or new notebook.

## My Notebooks Sidebar

The "My Notebooks" section in the Research sidebar is populated by `researchListNotebooks()` which queries the `notebooks` PostgreSQL table. Notebooks persist across app restarts.

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
