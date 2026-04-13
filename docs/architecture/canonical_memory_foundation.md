# Canonical Memory Foundation — Phase A

## Purpose

Phase A establishes the durable canonical memory store for Tala, replacing
ad-hoc file-based and in-memory persistence with a structured PostgreSQL
database backed by pgvector for future semantic search.

This foundation enables all future memory phases (retrieval orchestration,
advanced ranking, contradiction resolution, memory-grounded responses) to
operate on a single, well-defined, strongly-typed data layer.

## Design Principles

### Local-First

- Default configuration points to `localhost:5432/tala` with user `tala`.
- No internet connectivity required.
- Remote PostgreSQL is supported by overriding the connection string via the
  `TALA_DB_CONNECTION_STRING` environment variable or via the `database`
  section in `app_settings.json`.

### Repository Abstraction

All database access is mediated through the `MemoryRepository` interface
(`shared/memory/MemoryRepository.ts`). The concrete implementation
(`PostgresMemoryRepository`) uses parameterized SQL exclusively — no ORM,
no query builder, no hidden abstractions.

This makes the data layer:
- inspectable (every query is a plain SQL string)
- testable (the interface can be mocked or replaced)
- portable (a different backend could implement the same interface)

### SQL-File Migrations

Migrations live in `electron/migrations/` as numbered `.sql` files. The
`MigrationRunner` service tracks applied migrations in a `schema_migrations`
table and executes unapplied ones in filename order inside transactions.

This approach avoids migration framework dependencies and keeps the schema
fully visible as plain SQL.

## Schema Overview

### Core Tables

| Table | Purpose |
|---|---|
| `entities` | Named things Tala knows about (people, places, concepts) |
| `entity_aliases` | Alternative names for entities |
| `episodes` | Temporal records of events, conversations, interactions |
| `observations` | Structured facts/assertions about entities |
| `relationships` | Directed edges between entities |
| `artifacts` | External files, URIs, or content references |
| `memory_links` | Cross-domain typed edges between any memory objects |
| `embeddings` | Vector embeddings for semantic search (pgvector) |

### Supporting Tables

| Table | Purpose |
|---|---|
| `schema_migrations` | Migration version tracking |

### Key Design Choices

- **UUIDs** as primary keys (`uuid-ossp` extension)
- **JSONB** `attributes`/`metadata` columns for flexible extension
- **Explicit core fields** for type-safe querying
- **Temporal fields** (`created_at`, `updated_at`, `observed_at`) on all tables
- **GIN indexes** on JSONB columns for structured queries
- **HNSW vector index** on `embeddings.embedding` for cosine similarity

## Migration Files

| File | Content |
|---|---|
| `001_enable_extensions.sql` | Enables `uuid-ossp` and `vector` extensions |
| `002_core_entities.sql` | `entities` and `entity_aliases` tables |
| `003_core_memory_tables.sql` | `episodes`, `observations`, `relationships`, `artifacts`, `memory_links` |
| `004_embeddings.sql` | `embeddings` table with `vector(1536)` column |
| `005_indexes_constraints.sql` | All indexes, unique constraints, GIN and HNSW indexes |

## TypeScript Types

Domain types are defined in `shared/memory/memoryTypes.ts`:

- `EntityRecord` / `CreateEntityInput`
- `EntityAliasRecord` / `CreateEntityAliasInput`
- `EpisodeRecord` / `CreateEpisodeInput`
- `ObservationRecord` / `CreateObservationInput`
- `RelationshipRecord` / `CreateRelationshipInput`
- `ArtifactRecord` / `CreateArtifactInput`
- `MemoryLinkRecord` / `CreateMemoryLinkInput`
- `EmbeddingRecord` / `CreateEmbeddingInput`

## Repository Interface

`shared/memory/MemoryRepository.ts` defines:

- **Lifecycle**: `initialize()`, `runMigrations()`, `close()`
- **Entity**: `upsertEntity()`, `getEntityById()`, `findEntityByCanonicalName()`, `addEntityAlias()`
- **Episode**: `createEpisode()`, `getEpisodeById()`
- **Observation**: `createObservation()`
- **Relationship**: `createRelationship()`
- **Artifact**: `createArtifact()`
- **Memory Link**: `createMemoryLink()`
- **Embedding**: `createEmbedding()`

## Configuration

Database connection is configured via:

1. **Environment variables** (highest priority):
   - `TALA_DB_CONNECTION_STRING` — full PostgreSQL connection string
   - `TALA_DB_HOST`, `TALA_DB_PORT`, `TALA_DB_NAME`, `TALA_DB_USER`, `TALA_DB_PASSWORD`, `TALA_DB_SSL`
2. **`app_settings.json`** `database` section
3. **Defaults**: `localhost:5432/tala` user `tala` password `tala`

Configuration is resolved in `electron/services/db/resolveDatabaseConfig.ts`
(types and defaults are in `shared/dbConfig.ts`).

## Startup Integration

The canonical memory store initializes during `app.on('ready')` in
`electron/main.ts`. Initialization failures are non-fatal — the application
continues without canonical memory, and other subsystems are unaffected.

Shutdown is handled in `app.on('before-quit')`.

The repository can be accessed via `getCanonicalMemoryRepository()` from
`electron/services/db/initMemoryStore.ts`.

## Local PostgreSQL Setup

```bash
# Install PostgreSQL (macOS)
brew install postgresql@16
brew services start postgresql@16

# Install PostgreSQL (Ubuntu/Debian)
sudo apt-get install postgresql postgresql-contrib

# Install pgvector extension
# macOS:
brew install pgvector
# Ubuntu:
sudo apt-get install postgresql-16-pgvector

# Create database and user
psql postgres -c "CREATE USER tala WITH PASSWORD 'tala';"
psql postgres -c "CREATE DATABASE tala OWNER tala;"
psql tala -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql tala -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
```

## Phase B: Future Work

Phase B will route all memory writes through a `MemoryService` that:

- Coordinates writes across the repository
- Manages embedding generation
- Handles contradiction detection and resolution
- Provides retrieval orchestration with ranking
- Integrates with the existing cognitive pipeline
- Exposes IPC handlers for renderer-side memory queries

Phase A deliberately does **not** implement:
- Full retrieval orchestration
- Advanced semantic ranking
- Workflow engine integration
- UI changes
- MemoryService (beyond the raw repository)

---

## P7A: Memory Authority Lock

**Status**: Implemented

P7A extends the canonical memory foundation by enforcing PostgreSQL as the
**SINGLE SOURCE OF TRUTH** for all persistent memory. All other memory systems
(mem0, graph, RAG/vector index) become derived projections that MUST reference
`canonical_memory_id` and can be fully rebuilt from Postgres alone.

### New Tables (migration 011_memory_authority.sql)

| Table | Purpose |
|---|---|
| `memory_records` | Canonical truth for every persistent memory write |
| `memory_lineage` | Version history and supersession chain |
| `memory_projections` | Tracks which derived systems have received each record |
| `memory_integrity_issues` | Validation audit log and repair tracking |
| `memory_duplicates` | Duplicate detection groups |

### Memory Write Flow (Post-P7A)

```
AgentService.storeMemories()
  │
  ▼ (Step 1 — canonical write, BLOCKING)
  MemoryAuthorityService.createCanonicalMemory()
    │  1. normalize input
    │  2. compute canonical_hash (SHA-256)
    │  3. detectDuplicates() — exact hash match; semantic stub
    │  4. INSERT INTO memory_records (version=1, status='canonical')
    │  5. _appendLineage() — change_kind='create'
    │  6. _emitProjectionEvents() — insert 'pending' rows for mem0/graph/vector
    │
    └── returns canonical_memory_id
  │
  ▼ (Step 2 — derived writes, fire-and-forget, reference canonical_memory_id)
  ├── mem0 (MemoryService.add) — includes canonical_memory_id in metadata
  ├── RAG  (RagService.logInteraction)
  └── graph (mcpService.callTool 'process_memory') — source_ref = canonical_memory_id
```

### Authority Lifecycle

```
                       createCanonicalMemory()
                               │
                   ┌───────────▼───────────┐
                   │  authority_status =   │
                   │      'canonical'      │
                   └───────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
  updateCanonicalMemory()  (stays canonical)  tombstoneMemory()
  → version++                                → status = 'tombstoned'
  → projections = 'stale'                    → tombstoned_at = NOW()
                                             → lineage entry added
                                             ⚠ Cannot be updated after tombstone
```

### Integrity Validation

`MemoryAuthorityService.validateIntegrity()` detects:

| Check | Issue Kind | Severity |
|---|---|---|
| Projection references non-existent canonical record | `orphan` | error |
| Derived system version < canonical version | `projection_mismatch` | warning |
| Multiple canonical records share same hash | `duplicate` | error |
| Projection still 'projected' for tombstoned record | `tombstone_violation` | critical |

### Rebuild Pipeline

`MemoryAuthorityService.rebuildDerivedState()`:

- Reads all non-tombstoned canonical records in batches of 200
- Can scope execution by:
  - single `canonicalMemoryId`
  - `canonicalMemoryIds` list
  - `staleOnly`
  - `fullRebuild`
- Rebuilds derived projection state by synchronizing `memory_projections` rows from canonical `memory_records`
- Marks tombstoned/superseded canonical memories as stale in derived projections (never active)
- Verifies no canonical records have NULL content_text (unreachable)

### Service Location

```
electron/services/memory/MemoryAuthorityService.ts
shared/memory/authorityTypes.ts
```

### Global Constraints

- **All** persistent memory writes must flow through `MemoryAuthorityService.createCanonicalMemory()`
- mem0, graph, and RAG are **derived** — they cannot originate authoritative memory
- Duplicate detection runs **before** every canonical commit
- Tombstoned records are **never** deleted — required for lineage integrity and rebuild

