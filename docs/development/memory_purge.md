# Memory Purge Workflow

## Purpose

`memory:purge` is a dedicated, repeatable workflow for clearing Tala memory state while preserving schemas, migrations, and bootability.

This is intended for full memory/LTMF reset scenarios before rebuilding canonical memory from a clean baseline.

## What Gets Purged

PostgreSQL data rows only (table structures are preserved):

- Canonical authority tables:
  - `memory_records`
  - `memory_lineage`
  - `memory_projections`
  - `memory_integrity_issues`
  - `memory_duplicates`
  - `deferred_memory_work`
  - `memory_repair_outcomes`
- Legacy canonical memory tables:
  - `entities`
  - `entity_aliases`
  - `episodes`
  - `observations`
  - `relationships`
  - `artifacts`
  - `memory_links`
  - `embeddings`
- RAG ingestion/embedding tables:
  - `source_documents`
  - `document_chunks`
  - `chunk_embeddings`
- Graph projection tables:
  - `graph_nodes`
  - `graph_edges`
  - `graph_events`
  - `graph_evidence`

Research/notebook collections are intentionally excluded by default:

- Preserved tables:
  - `notebooks`
  - `search_runs`
  - `search_run_results`
  - `notebook_items`

Reason: this workflow is scoped to memory/LTMF + derived retrieval state reset, not a destructive wipe of research collections/history.

Filesystem-derived stores:

- `mcp-servers/tala-core/data/simple_vector_store` (contents only)
- `data/mem0_storage` (contents only, if present)
- `mcp-servers/mem0-core/data/mem0_storage` (contents only, if present)
- `mcp-servers/tala-memory-graph/tala_memory_v1.db` (file removed, if present)
- `tala_memory_v1.db` (file removed, if present)
- `memory/processed/roleplay_autobio_canon_migration` (contents only, if present)

## What Is Preserved

- All SQL schemas, table definitions, indexes, constraints, and migrations
- Folder structure (directories are retained; contents are cleared where targeted)
- Application code and runtime bootstrap logic
- Normal startup ability (`initCanonicalMemory`, migration runner, bootstrap coordinator)

## Safety Behavior

- Dry-run is the default unless `--yes` is provided.
- By default the command refuses non-local DB targets.
- By default the command refuses non-`tala` database names.
- `--allow-remote` is required to bypass local/DB-name safeguards.

## Commands

Dry-run (safe preview):

```bash
npm run memory:purge
```

Equivalent explicit dry-run:

```bash
npm run memory:purge:dry
```

Execute purge:

```bash
npm run memory:purge -- --yes
```

DB-only purge (skip filesystem cleanup):

```bash
npm run memory:purge -- --yes --skip-files
```

Post-purge verification command:

```bash
npm run memory:purge:verify
```

## Expected Verification After Purge

1. Run `npm run memory:purge:verify` and confirm:
   - canonical memory tables are empty
   - graph tables are empty
   - `source_documents` / `document_chunks` / `chunk_embeddings` are empty
   - `simple_vector_store` is empty
   - mem0 derived storage is empty
   - `schema_migrations` still exists and has rows
2. Run `npm run memory:check` to confirm memory subsystem health signals and empty-state behavior.
3. Start app/runtime and verify canonical writes still work (schemas intact, migrations still runnable).
4. Re-import/rebuild memory corpus (for example, one-time autobio canon import) and verify retrieval paths.
