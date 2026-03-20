# Memory Bootstrap — Local Docker-Based PostgreSQL + pgvector

## Purpose

This document describes how Tala provisions and manages its local canonical
memory store (PostgreSQL + pgvector) during development and bootstrap.

The goal is **local-first, zero-prerequisite memory** — developers should not
need to install or configure PostgreSQL manually. Docker is used as the
canonical local provisioning mechanism when no other DB is configured.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  bootstrap-memory.sh / bootstrap-memory.ps1         │
│  (scripts layer — runs before app)                  │
│                                                     │
│  1. TALA_DB_CONNECTION_STRING set?                  │
│     → yes: skip, use external DB                    │
│     → no:  check-db-reachable.js                    │
│            reachable? → skip                        │
│            not reachable? → docker compose up       │
│                             wait for healthcheck    │
│                             app starts normally     │
└─────────────────────────────────────────────────────┘
        ↓ (DB ready or degraded)
┌─────────────────────────────────────────────────────┐
│  Electron main.ts — initCanonicalMemory()           │
│  (app layer — runs connection + migrations)         │
│                                                     │
│  PostgresMemoryRepository → MigrationRunner         │
│  resolveDatabaseConfig() → env/settings/defaults   │
└─────────────────────────────────────────────────────┘
```

Bootstrap is strictly a **pre-app provisioning concern**. It never runs
migrations. Migrations remain the app's responsibility via `MigrationRunner`
and `initCanonicalMemory()` in `electron/main.ts`.

---

## Configuration Priority

| Priority | Source |
|---|---|
| 1 (highest) | `TALA_DB_CONNECTION_STRING` environment variable |
| 2 | `TALA_DB_HOST` / `TALA_DB_PORT` / `TALA_DB_NAME` / `TALA_DB_USER` / `TALA_DB_PASSWORD` env vars |
| 3 | `database` section in `app_settings.json` |
| 4 (default) | `localhost:5432/tala` (user: tala, password: tala) |

When `TALA_DB_CONNECTION_STRING` is set, the bootstrap scripts exit
immediately without touching Docker. This is the recommended path for remote
or CI databases.

---

## Files

| File | Purpose |
|---|---|
| `docker-compose.memory.yml` | Defines the local PostgreSQL + pgvector container |
| `scripts/bootstrap-memory.sh` | Bootstrap entrypoint (Linux / macOS) |
| `scripts/bootstrap-memory.ps1` | Bootstrap entrypoint (Windows PowerShell) |
| `scripts/stop-memory.sh` | Stop local memory stack (Linux / macOS) |
| `scripts/stop-memory.ps1` | Stop local memory stack (Windows PowerShell) |
| `scripts/check-db-reachable.js` | Node.js TCP probe — tests whether configured DB port is open |
| `scripts/memory-cmd.js` | Cross-platform dispatcher invoked by npm scripts |

---

## Docker Compose Stack

File: `docker-compose.memory.yml`

- **Image**: `pgvector/pgvector:pg16` — PostgreSQL 16 with pgvector extension
- **Container**: `tala-memory-db`
- **Default credentials** (local-only, not secrets):
  - host: `localhost`
  - port: `5432`
  - database: `tala`
  - user: `tala`
  - password: `tala`
- **Volume**: `tala_memory_data` — named persistent volume, survives restarts
- **Healthcheck**: `pg_isready -U tala -d tala` (5 s interval, 10 retries)
- **Restart policy**: `unless-stopped`

---

## npm Commands

| Command | Description |
|---|---|
| `npm run memory:up` | Bootstrap local memory stack (idempotent) |
| `npm run memory:down` | Stop local memory stack (data preserved) |
| `npm run memory:logs` | Tail container logs |
| `npm run memory:reset` | Destroy volume + restart (wipes all local memory) |
| `npm run dev:with-memory` | Bootstrap memory, then launch normal dev flow |

---

## Developer Workflows

### Start dev with automatic memory provisioning

```bash
npm run dev:with-memory
```

This is the recommended daily-driver command. It:
1. Runs `bootstrap-memory.sh` (or `.ps1` on Windows via shell)
2. Starts the DB container if not already running
3. Waits for the DB to be healthy
4. Launches `npm run dev` normally

### Start memory stack independently

```bash
npm run memory:up
```

### Stop memory stack (keep data)

```bash
npm run memory:down
```

### Inspect memory container logs

```bash
npm run memory:logs
```

### Reset memory (wipe all data)

```bash
npm run memory:reset
```

**Warning**: This destroys the `tala_memory_data` Docker volume. All stored
memories, entities, episodes, and observations will be lost. Migrations will
re-run on next app start.

### Use a remote or custom PostgreSQL

Set the environment variable before starting:

```bash
export TALA_DB_CONNECTION_STRING="postgresql://user:pass@my-db-host:5432/tala"
npm run dev
```

The bootstrap scripts detect this variable and skip Docker provisioning
entirely. The app connects to the specified DB as normal.

---

## Degraded Mode

If Docker is unavailable or the container fails to start, the bootstrap
scripts **exit 0 with a warning** rather than crashing. This preserves the
existing behavior of `initCanonicalMemory()` in `electron/main.ts`, which is
already non-fatal — the app starts and the memory store is simply unavailable.

Log messages are prefixed with `[memory-bootstrap]` for easy identification.

When running in degraded mode:
- The app starts normally
- Memory operations (store/retrieve) fail gracefully
- The inference and chat flows continue without memory context

To diagnose:

```bash
npm run memory:logs
# or
docker inspect tala-memory-db
```

---

## Reachability Probe

`scripts/check-db-reachable.js` — pure Node.js TCP probe (no npm dependencies).

Resolves the target from:
1. `TALA_DB_CONNECTION_STRING` (parsed for host/port)
2. `TALA_DB_HOST` / `TALA_DB_PORT` env vars
3. Default: `localhost:5432`

Opens a socket with a 3-second timeout. Exit 0 = reachable, exit 1 = not reachable.

This probe is also usable standalone:

```bash
node scripts/check-db-reachable.js && echo "DB up" || echo "DB down"
```

---

## Remote PostgreSQL Support

No local assumptions are hardcoded into the repository or app code.

To use a managed/remote PostgreSQL:

```bash
export TALA_DB_CONNECTION_STRING="postgresql://user:pass@host:5432/tala"
```

The bootstrap scripts skip Docker provisioning. The app's `resolveDatabaseConfig()`
reads this variable at the highest priority.

For production or staging environments, this is the expected configuration path.

---

## Separation of Concerns

| Layer | Responsibility |
|---|---|
| `docker-compose.memory.yml` | Container definition only — no schema, no init SQL |
| `bootstrap-memory.sh/.ps1` | Provision container; wait for readiness |
| `check-db-reachable.js` | TCP-level DB probe |
| `electron/services/db/initMemoryStore.ts` | App-level connection + migration |
| `electron/services/db/MigrationRunner.ts` | Schema migrations |
| `electron/services/db/resolveDatabaseConfig.ts` | Config resolution from env/settings/defaults |

Migrations are **never** run from bootstrap scripts. They remain the app's
responsibility via `initCanonicalMemory()` in `electron/main.ts`.

---

## Related Files

- `shared/dbConfig.ts` — `DatabaseConfig` interface and defaults
- `electron/services/db/resolveDatabaseConfig.ts` — runtime config resolver
- `electron/services/db/PostgresMemoryRepository.ts` — repository implementation
- `electron/services/db/MigrationRunner.ts` — migration runner
- `electron/migrations/` — SQL migration files
- `electron/main.ts` (lines 46–51) — `initCanonicalMemory()` call site
- `docs/architecture/canonical_memory_foundation.md` — Phase A memory architecture
