# One-Time Autobiographical Canon Import

## Purpose

This runbook documents the dedicated migration tool for Tala's autobiographical LTMF corpus in `D:\temp`.

Entrypoint:

- `scripts/migrations/oneTimeAutobioCanonImport.ts`

This is a one-purpose migration tool. It is not part of the normal runtime ingestion flow.

## Why this format is used

The importer normalizes source events into Markdown files with YAML frontmatter and then calls `tala-core` `ingest_file`.

This is the preferred migration path because `mcp-servers/tala-core/server.py` already:

- parses YAML frontmatter in `ingest_file`
- computes embeddings and chunk metadata
- applies canonical autobiographical metadata used by retrieval filters in `TalaContextRouter`

No runtime ingestion contract changes are required.

## Canonical normalization schema

Each normalized event includes:

- `id` (deterministic event id)
- `source_type: ltmf`
- `memory_type: autobiographical`
- `canon: true`
- `age` (when inferred)
- `age_sequence` (explicit or deterministic fallback in age bucket)
- `life_stage` (optional)
- `title`
- `summary`
- `source_path`
- `source_hash`

## Source inspection and inference

Phase 1 inspection recursively scans a source root and reports:

- file count
- extension distribution
- likely structured vs unstructured files
- likely LTMF candidates
- presence of age/life-stage markers
- recommended import strategy with evaluated alternatives

Age and sequence are inferred in this order:

1. frontmatter fields (for example `age`, `age_year`, `age_sequence`, `order`)
2. filename patterns (for example `age_17`, `LTMF-A17`, `memory_03`)
3. content markers (for example `Age / Life Stage: 17`)
4. deterministic fallback ordering

## Dry-run and import

Dry-run mode is read-only and safe:

```bash
npm run memory:import:autobio-canon -- --source "D:\temp" --dry-run --report
```

Import mode writes normalized migration files under `memory/processed/roleplay_autobio_canon_migration` and ingests them through `tala-core`:

```bash
npm run memory:import:autobio-canon -- --source "D:\temp" --import --report
```

Optional re-embedding for unchanged records:

```bash
npm run memory:import:autobio-canon -- --source "D:\temp" --import --force-reembed --report
```

## Idempotency behavior

The importer keeps a migration manifest:

- `memory/processed/roleplay_autobio_canon_migration/.autobio_canon_import_manifest.json`

On repeated runs, unchanged events are skipped unless `--force-reembed` is provided.

## Verification output

Import report includes:

- normalized event count
- count with inferred `age`
- canon autobiographical count
- age-17 count
- query verification counts for:
  - `when you were 17`
  - `at 17`
  - `during your seventeenth year`

## LTMF Identity/ Retrieval Enrichment

Use this repo-local script to enrich raw LTMF corpus files in place with event identity and retrieval-oriented frontmatter.

Entrypoint:

- `scripts/maintenance/enrich_memory_frontmatter.ts`
- npm alias: `npm run memory:ltmf:enrich -- --root "D:\temp" --dry-run`

Supported source file extensions (default):

- `.md`
- `.markdown`

Optional source extension:

- `.txt` only when `--include-txt` is provided

Behavior:

- recursively scans the target root
- filters to likely LTMF files (by metadata/content/path markers)
- parses YAML frontmatter when present and preserves all existing fields
- adds only missing fields by default
- overwrites those fields only when `--force` is passed
- preserves narrative/story body (no body rewrite)
- prints per-file decision logs and summary counts (`scanned`, `enriched`, `skipped`, `failed`)

CLI options:

- `--root "<path>"` target root directory
- `--dry-run` compute and report changes without writing
- `--force` regenerate/overwrite the target enrichment fields
- `--include-txt` allow `.txt` files in addition to Markdown
- `--include-ext .md,.txt` override extension filter

Generated fields:

- `event_identity.canonical_name`
- `event_identity.aliases`
- `event_identity.tags`
- `event_identity.is_named_event`
- `event_identity.recall_priority`
- `retrieval.keywords`
- `retrieval.embedding_hint`

Heuristic source signals:

- `title` (frontmatter or Story Outline title extraction)
- `Theme Anchor`
- `Inciting Incident`
- `Behavioral Patterns`
- `Emotional Tendencies`
- `Environmental / Situational Triggers`
- `Long-Term Impact Hooks`
- file stem/path tokens as deterministic fallback

Validation gates (skip-write on failure):

- canonical names wrapped in parentheses or machine-style labels are rejected
- aliases must be short recall phrases (3-5 items)
- tags must be compact concepts (4-8 items, max 3 words each)
- embedding hint must be one sentence in the required format and cannot include section-label fragments

