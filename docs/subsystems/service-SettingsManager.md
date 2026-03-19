# Service: SettingsManager.ts

**Source**: [electron\services\SettingsManager.ts](../../electron/services/SettingsManager.ts)

## Purpose
High-integrity, cached I/O for `app_settings.json`. Provides atomic writes, burst-resistant caching, deep-merge schema filling, and auto-recovery from JSON corruption.

## Public API

### `loadSettings(settingsPath, caller?)`
Returns the full settings object.  Uses a **30-second TTL cache** to avoid repeated disk reads during steady-state operation.  Pass an optional `caller` label (e.g. `"AgentService.chat"`) to identify the source in logs.

### `saveSettings(settingsPath, data)`
Atomically writes the settings object using a `.tmp` rename strategy.  Always refreshes the in-memory cache after a successful write.

### `setActiveMode(settingsPath, mode)`
Validates and persists the active mode (`rp | hybrid | assistant`).  Updates the cache immediately via `saveSettings`, then verifies the write via a cache read.

### `getActiveMode(settingsPath, caller?)`
Returns the current active mode from the in-memory cache.  Uses a **presence-only cache check** (not TTL-based) because `activeMode` can only change via `setActiveMode → saveSettings`, which always refreshes the cache.  A lazy disk load is performed only on the very first call (cold cache).  Pass `caller` for log observability.

### `refreshSettingsFromDisk(settingsPath, caller?)`
Explicitly invalidates the cache and forces a disk reload.  Use this only when an external process may have modified `app_settings.json` and fresh values are required immediately (e.g. a file-watch callback or an explicit IPC refresh command).  **Do not call this on hot paths or polling loops** — use `getActiveMode()` instead.

### `deepMerge(target, source)`
Deep-merges two plain objects, used internally to fill missing schema keys from `DEFAULT_SETTINGS` at load time.

## Cache Behaviour

| Operation | Cache impact |
|-----------|-------------|
| `loadSettings()` within TTL | Returns cached copy — no disk read |
| `loadSettings()` after 30 s TTL | Reads disk, refreshes cache |
| `saveSettings()` | Writes disk, refreshes cache |
| `setActiveMode()` | Writes disk via `saveSettings`, refreshes cache |
| `getActiveMode()` with warm cache | Returns cached value — no TTL check, no disk read |
| `getActiveMode()` with cold cache | Calls `loadSettings()` once to warm cache |
| `refreshSettingsFromDisk()` | Invalidates cache, forces disk read |

## Logging

| Event | Level | Description |
|-------|-------|-------------|
| Disk load | INFO | `[SettingsManager] loadSettings activeMode=X source=disk` |
| Mode write | INFO | `[SettingsManager] setActiveMode called with=X`, `writing ...`, `save ...`, `verify ...` |
| Cold-cache mode read | INFO | `[SettingsManager] getActiveMode caller=X source=disk value=Y` |
| Explicit refresh | INFO | `[SettingsManager] refreshSettingsFromDisk caller=X` |

Routine warm-cache reads do **not** emit a log line to avoid noise on UI polling or per-turn hot paths.
