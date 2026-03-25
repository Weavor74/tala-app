# Memory Bootstrap — Native-First Local PostgreSQL Runtime

## Purpose

This document describes how Tala provisions and manages its local canonical
memory store (PostgreSQL + pgvector) during startup.

**Primary goal: local-first, zero-prerequisite memory without requiring Docker.**

The default bootstrap path is a Tala-managed native PostgreSQL runtime. Docker
is supported as an optional developer convenience, not as a required dependency.

---

## Bootstrap Priority Order

```
1. TALA_DB_CONNECTION_STRING set?
   → Yes: use it directly (external / remote / CI database)

2. bootstrapMode === 'external-only'?
   → Yes: use env/settings config as-is, no local runtime startup

3. Tala-managed native runtime (primary local-first path)
   → Check binary assets present in runtime root
   → initdb on first run (creates the cluster)
   → Start postgres process (localhost:5432 only)
   → Wait for readiness
   → Run migrations via MigrationRunner

4. Docker fallback
   → Only attempted if allowDockerFallback === true (opt-in)
   → Does NOT start Docker — only probes for an already-running instance
   → To start: npm run memory:up (developer workflow)

5. Degraded mode
   → No viable path found
   → App continues; memory features unavailable
   → Clear warning logged
```

Docker is **not started automatically** by the app. It remains an explicit
developer tool, not a startup dependency.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  electron/main.ts — app.on('ready')                                  │
│                                                                       │
│  await initCanonicalMemory()                                          │
└─────────────────────────────────────────────────────────────────────┘
         ↓ (non-fatal: failure → degraded mode)
┌─────────────────────────────────────────────────────────────────────┐
│  electron/services/db/initMemoryStore.ts                             │
│                                                                       │
│  1. If explicit dbConfig provided → skip coordinator                 │
│  2. Otherwise → DatabaseBootstrapCoordinator.bootstrap()             │
│  3. Use resulting DatabaseConfig                                      │
│  4. PostgresMemoryRepository.initialize()                            │
│  5. MigrationRunner.runAll()                                         │
└─────────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────────┐
│  electron/services/db/DatabaseBootstrapCoordinator.ts                │
│                                                                       │
│  resolveDatabaseBootstrapPlan()  ←  env vars + settings              │
│                                                                       │
│  path: native-runtime                                                 │
│    LocalDatabaseRuntime  → platform paths + connection config        │
│    PostgresProcessManager → initdb / start / waitReady / stop       │
│                                                                       │
│  path: docker-fallback (opt-in)                                      │
│    probeTcpPort(host, port) → reachable? use it : degraded          │
│                                                                       │
│  path: external / local-configured                                    │
│    resolveDatabaseConfig() → env/settings/defaults                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Configuration Priority

| Priority | Source |
|---|---|
| 1 (highest) | `TALA_DB_CONNECTION_STRING` environment variable |
| 2 | `TALA_DB_BOOTSTRAP_MODE` environment variable (`auto`\|`native`\|`docker`\|`external-only`) |
| 3 | `TALA_DB_ALLOW_DOCKER_FALLBACK` environment variable (`true`\|`1`) |
| 4 | `databaseBootstrap` section in `app_settings.json` |
| 5 | `TALA_DB_HOST` / `TALA_DB_PORT` / `TALA_DB_NAME` / `TALA_DB_USER` / `TALA_DB_PASSWORD` env vars |
| 6 (default) | Tala-managed native runtime on `127.0.0.1:5432` |

---

## Native Runtime Platform Paths

The Tala-managed native runtime uses platform-appropriate storage roots:

| Platform | App data root |
|---|---|
| Windows | `%APPDATA%\Tala\` |
| macOS | `~/Library/Application Support/Tala/` |
| Linux | `~/.local/share/Tala/` |

Under each root:

| Subdirectory | Purpose |
|---|---|
| `runtime/postgres/` | Bundled PostgreSQL binaries (read-only in production); `bin/postgres` is the presence sentinel |
| `data/postgres/` | PostgreSQL cluster data directory (writable) |
| `data/logs/postgres/` | PostgreSQL server log output; log file is `postgres.log` |

`npm run memory:up` checks for `runtime/postgres/bin/postgres[.exe]` (relative to the app/repo root)
to determine whether native runtime assets are present before deciding whether to log degraded guidance.

`npm run memory:logs` tails `data/logs/postgres/postgres.log`. If the file does not exist yet (the
native runtime has not started), the command exits immediately with an informative message.

Path resolution is handled by `LocalDatabaseRuntime` and can be overridden via
`databaseBootstrap.localRuntime.runtimePathOverride` / `dataPathOverride` in
settings, or via env vars.

---

## Native Runtime Connection Defaults

The Tala-managed runtime uses these local-only defaults:

| Setting | Value |
|---|---|
| host | `127.0.0.1` (localhost only, never network-exposed) |
| port | `5432` (overridable via `portOverride`) |
| database | `tala` |
| user | `tala` |
| password | `tala_local` |
| SSL | disabled |

---

## Runtime Assets

The native runtime requires PostgreSQL binaries and the pgvector extension to
be present in the runtime root directory.

**Current status:** The runtime manager architecture and all bootstrap code
paths are implemented. Platform-specific binary packaging (bundling PostgreSQL
binaries into the app distribution) is a separate delivery milestone.

Until platform binaries are bundled:
- The native runtime path will log a clear `MissingRuntimeAssetsError` with
  actionable guidance.
- The app falls back to degraded mode.
- Developers can set `TALA_DB_CONNECTION_STRING` to connect to an existing
  PostgreSQL instance, or install PostgreSQL natively and configure
  `TALA_DB_HOST` / `TALA_DB_PORT` / `TALA_DB_USER` / `TALA_DB_PASSWORD`.

pgvector is required for canonical memory embeddings. If the runtime bundle
includes PostgreSQL but not pgvector, a warning is surfaced during bootstrap
(the process starts; migrations will fail when creating the `vector` extension).

---

## Files

| File | Purpose |
|---|---|
| `electron/services/db/DatabaseBootstrapCoordinator.ts` | Orchestrates the full bootstrap flow |
| `electron/services/db/resolveDatabaseBootstrapPlan.ts` | Determines bootstrap path from env/config |
| `electron/services/db/LocalDatabaseRuntime.ts` | Platform path resolution and connection config |
| `electron/services/db/PostgresProcessManager.ts` | postgres process lifecycle (initdb, start, stop) |
| `electron/services/db/initMemoryStore.ts` | Entry point: wires coordinator → repository → migrations |
| `electron/services/db/resolveDatabaseConfig.ts` | Env/settings → DatabaseConfig resolution |
| `shared/dbBootstrapConfig.ts` | Bootstrap configuration types (shared, renderer-safe) |
| `shared/dbConfig.ts` | DatabaseConfig types and defaults |
| `docker-compose.memory.yml` | Optional Docker-based local PostgreSQL + pgvector |
| `scripts/memory-cmd.js` | Cross-platform dispatcher for memory commands (up / down / logs) |

---

## Developer Convenience Commands

| Command | Description |
|---|---|
| `npm run memory:up` | Pre-flight check: verify running PostgreSQL or native runtime assets; exit with actionable guidance if neither available |
| `npm run memory:down` | Stop the Docker-based stack if it was started manually (data preserved) |
| `npm run memory:logs` | Tail `data/logs/postgres/postgres.log`; prints informative message and exits if the file does not exist yet |
| `npm run memory:reset` | Stop Docker-based stack and remove volume + re-run memory:up |
| `npm run dev:with-memory` | Run memory:up pre-flight check then launch dev |

**Docker is not started automatically by `memory:up`.** If you prefer to run
PostgreSQL via Docker for development, start it manually and optionally enable
the Docker fallback probe:

```bash
docker compose -f docker-compose.memory.yml up -d
TALA_DB_ALLOW_DOCKER_FALLBACK=true npm run dev
```

Or via settings:
```json
{ "databaseBootstrap": { "allowDockerFallback": true } }
```

---

## Remote PostgreSQL Support

Set `TALA_DB_CONNECTION_STRING` to bypass all local runtime logic:

```bash
export TALA_DB_CONNECTION_STRING="postgresql://user:pass@my-db-host:5432/tala"
npm run dev
```

The bootstrap coordinator detects this variable at the highest priority and
skips native runtime startup entirely.

---

## Bootstrap Configuration Reference

`shared/dbBootstrapConfig.ts` defines `DatabaseBootstrapConfig`:

```typescript
{
  // 'auto'          — native first, Docker fallback if allowed, then degraded
  // 'native'        — native runtime only
  // 'docker'        — Docker only (developer override)
  // 'external-only' — use env/settings config, no local runtime
  bootstrapMode: 'auto' | 'native' | 'docker' | 'external-only';

  // Whether Docker is probed as a fallback (auto mode only). Default: false.
  allowDockerFallback: boolean;

  localRuntime: {
    enabled: boolean;              // Default: true
    portOverride?: number;         // Default: 5432
    runtimePathOverride?: string;  // Override binary root
    dataPathOverride?: string;     // Override data directory
  };
}
```

In `app_settings.json`:
```json
{
  "databaseBootstrap": {
    "bootstrapMode": "auto",
    "allowDockerFallback": false,
    "localRuntime": { "enabled": true }
  }
}
```

---

## Degraded Mode

If no viable bootstrap path is found the coordinator logs a structured warning
and returns a degraded result. `initCanonicalMemory()` in `electron/main.ts` is
called non-fatally; the app starts and memory operations fail gracefully.

To diagnose:
- Check `logs/postgres/postgres.log` in the platform data root
- Check the Electron main-process log for `[DatabaseBootstrapCoordinator]` entries
- Run `npm run memory:check` for a memory subsystem audit

---

## Separation of Concerns

| Layer | Responsibility |
|---|---|
| `resolveDatabaseBootstrapPlan` | Determine bootstrap path from env/config |
| `LocalDatabaseRuntime` | Platform path resolution, connection config |
| `PostgresProcessManager` | postgres process lifecycle (initdb, start, stop, probe) |
| `DatabaseBootstrapCoordinator` | Orchestrate bootstrap flow, native runtime lifetime |
| `initMemoryStore.ts` | Wire coordinator → repository → migrations |
| `MigrationRunner` | Schema migrations (always app responsibility, never bootstrap scripts) |
| `docker-compose.memory.yml` | Optional Docker container definition only |
| `scripts/memory-cmd.js` | Developer CLI for Docker-based memory stack |

Migrations are **never** run from bootstrap scripts or Docker init SQL.
They remain the app's responsibility via `MigrationRunner` and
`initCanonicalMemory()` in `electron/main.ts`.

---

## Related Files

- `shared/dbConfig.ts` — `DatabaseConfig` interface and defaults
- `shared/dbBootstrapConfig.ts` — `DatabaseBootstrapConfig` interface and defaults
- `electron/services/db/resolveDatabaseConfig.ts` — runtime config resolver
- `electron/services/db/PostgresMemoryRepository.ts` — repository implementation
- `electron/services/db/MigrationRunner.ts` — migration runner
- `electron/migrations/` — SQL migration files
- `electron/main.ts` (lines ~258–262) — `initCanonicalMemory()` call site
- `docs/architecture/canonical_memory_foundation.md` — Phase A memory architecture

