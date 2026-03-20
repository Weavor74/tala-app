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
| `postgres-runtime/` | Bundled PostgreSQL binaries (read-only in production) |
| `data/postgres/` | PostgreSQL cluster data directory (writable) |
| `logs/postgres/` | PostgreSQL server log output (writable) |

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
- The app falls back to degraded mode (or Docker if explicitly enabled).
- Developers can use `npm run memory:up` (Docker) or set
  `TALA_DB_CONNECTION_STRING` to use an existing PostgreSQL instance.

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
| `scripts/memory-cmd.js` | Cross-platform dispatcher for Docker memory commands |

---

## Docker Support (Optional Developer Convenience)

Docker remains supported as an explicit developer workflow. It is **not** used
during standard app startup.

| Command | Description |
|---|---|
| `npm run memory:up` | Start Docker-based PostgreSQL + pgvector stack |
| `npm run memory:down` | Stop Docker-based stack (data preserved) |
| `npm run memory:logs` | Tail Docker container logs |
| `npm run memory:reset` | Destroy Docker volume + recreate (wipes all data) |
| `npm run dev:with-memory` | Start Docker memory stack then launch dev |

To allow the app to fall back to a running Docker instance during bootstrap:

```bash
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

