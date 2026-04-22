# TALA Bootstrap and Setup Guide

## Overview

This document describes how to set up the TALA environment on a new machine, the
canonical entry points for each stage, and how path resolution works across all
setup scripts.

Runtime authority notes:

- PostgreSQL is the canonical memory authority runtime.
- pgvector is the Postgres vector capability when installed/available.
- Inference selection is deterministic and local-first (Ollama-priority in auto mode).
- Storage authority is governed by the Storage Registry (`StorageProviderRegistryService`).

---

## Canonical Setup Entry Points

| Entry point | Platform | Purpose |
|---|---|---|
| `bootstrap.sh` | Unix / macOS / Linux | Full bootstrap: checks prerequisites, installs Debian/Ubuntu Linux system deps, creates runtime dirs, downloads model, installs npm + Python deps |
| `bootstrap.ps1` | Windows (PowerShell) | Same as above for Windows |
| `start.sh` | Unix / macOS | Launch TALA dev environment (`npm run dev`) |
| `start.bat` | Windows | Same for Windows |
| `scripts/verify-setup.sh` | Unix / macOS / Linux | Health check: validate environment readiness after bootstrap |
| `scripts/verify-setup.ps1` | Windows (PowerShell) | Same for Windows |

**Quick start:**

```bash
# Unix / macOS
bash bootstrap.sh
bash scripts/verify-setup.sh   # optional check
bash start.sh

# Windows
.\bootstrap.ps1
pwsh scripts\verify-setup.ps1  # optional check
.\start.bat
```

---

## Prerequisites

Before running `bootstrap.sh` / `bootstrap.ps1`, install:

| Prerequisite | Minimum version | Notes |
|---|---|---|
| Node.js | v18+ | https://nodejs.org/ |
| npm | bundled with Node.js | |
| Python | 3.10+ | https://python.org/ — Windows: check "Add Python to PATH" |
| curl or wget | any | Unix/macOS — used to download the default GGUF model |

---

## What Bootstrap Does

Bootstrap is a six-step idempotent script safe to re-run at any time (plus post-bootstrap readiness checks):

### Step 1 — Environment checks
Verifies Node.js, npm, and Python 3 are in `PATH`.  
Fails immediately with a clear diagnostic if any are missing.

### Step 2 — Runtime directories
Creates `models/`, `data/`, `bin/python-mac/` (or `python-linux/`), and `memory/`
under the repo root.  All paths are repo-relative.

### Step 3 — Default GGUF model
Downloads `Llama-3.2-3B-Instruct-Q4_K_M.gguf` (~2 GB) into `models/` if not already
present.  Skipped on subsequent runs.

### Step 4 — Node.js dependencies
Runs `npm install` in the repo root.

### Step 5 — Python virtual environments
Creates a per-module `venv/` and installs the module's `requirements.txt` for each
Python component that exists in the repo:

| Module | venv location |
|---|---|
| `local-inference` | `local-inference/venv/` |
| `mcp-servers/tala-core` | `mcp-servers/tala-core/venv/` |
| `mcp-servers/mem0-core` | `mcp-servers/mem0-core/venv/` |
| `mcp-servers/astro-engine` | `mcp-servers/astro-engine/venv/` |
| `mcp-servers/tala-memory-graph` | `mcp-servers/tala-memory-graph/venv/` |
| `mcp-servers/world-engine` | `mcp-servers/world-engine/venv/` |

If a module directory does not exist it is skipped silently.

### Setup Bootstrap vs Storage Bootstrap

- This guide describes **environment bootstrap** (install/runtime provisioning scripts).
- Storage bootstrap is separate and runtime-managed:
  - one-time legacy import into Storage Registry
  - deterministic Provider hydration
  - missing Role gap fill only
  - explicit assignments preserved
  - no silent post-bootstrap legacy override
  - explicit re-import action only (`storage:reimportLegacy`)

---

## Path Resolution

All setup scripts derive the repo root from their own filesystem location, **not** from
the caller's working directory.  This means every script works correctly regardless of
where it is launched from.

### Runtime Storage Contract (Electron Main Process)

Tala now treats app-root-relative storage as the default rule for Tala-owned files.
`electron/services/PathResolver.ts` is the authoritative resolver and defaults all
application-owned writes under:

- `<app-root>/data/logs`
- `<app-root>/data/cache`
- `<app-root>/data/temp`
- `<app-root>/data/memory`
- `<app-root>/data/reflection`
- `<app-root>/data/diagnostics`

Additional app-root-owned roots are created by bootstrap for portability:

- `<app-root>/runtime`
- `<app-root>/models`
- `<app-root>/exports`

If a Tala-owned path resolves outside app root unexpectedly, the main process logs:

- `[PathGuard] write escaped app root path=...`

Explicit operator-configured external paths are still allowed, but are logged as:

- `[PathGuard] external-by-configuration ...`

### Bash scripts (root-level)

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"        # bootstrap.sh and start.sh are at repo root
cd "$REPO_ROOT"
```

### Bash scripts in `scripts/diagnostics/`

These scripts are two directory levels below the repo root:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"   # scripts/diagnostics/ → scripts/ → repo root
cd "$REPO_ROOT"
```

### PowerShell scripts (root-level)

```powershell
$RepoRoot = $PSScriptRoot     # bootstrap.ps1 is at repo root
Set-Location $RepoRoot
```

### PowerShell scripts in `scripts/` or `scripts/diagnostics/`

```powershell
# scripts/ (one level down)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# scripts/diagnostics/ (two levels down)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
```

### Batch scripts in `scripts/diagnostics/`

```bat
:: %~dp0 = scripts\diagnostics\ (includes trailing backslash)
:: Two levels up reaches repo root.
cd /d "%~dp0..\.."
```

> **Rule**: never use `%~dp0..` (one level) for scripts inside `scripts\diagnostics\`.
> Always use `%~dp0..\..` to reach the repo root.

---

## Health Check / Verification

After running bootstrap, you can verify the environment with:

```bash
# Unix / macOS
bash scripts/verify-setup.sh

# Windows
pwsh scripts\verify-setup.ps1

# Via npm
npm run setup:verify
```

The verify script checks each subsystem and prints a `PASS / FAIL / WARN` per item:

- Repo root resolution
- Node.js + npm present
- `node_modules` installed
- Python 3 present
- Linux native toolchain, `pg_config`, and key Electron shared libraries (Linux only)
- Per-module Python venvs installed
- Local inference Python binary and GGUF model present
- Key project files present

The script exits with code `0` on all-pass, `1` if any critical check fails.

### Storage Authority Verification (after first app launch)

In Settings:
1. Open Storage and verify `Storage Authority Summary` reports canonical authority and registry health.
2. Confirm Provider and Role visibility is populated (authority class, origin, validation state, reason codes).
3. If legacy import was expected, verify bootstrap outcome and run count in summary.
4. Use explicit legacy re-import only when operator-intended.

---

## Contributor Documentation Checks

For qualifying changes (behavior, contracts, architecture, workflows, guardrails, operations, setup), run:

```bash
npm run docs:heal-and-validate
```

When code-backed docs are out of date, regenerate first:

```bash
npm run docs:regen
npm run docs:heal-and-validate
```

`npm run docs:selfheal` is kept as a compatibility alias and runs the same enforcement path after regeneration.

---

## Local Inference (provider registry)

Tala uses deterministic provider selection with a local-first waterfall:

1. `ollama`
2. `vllm`
3. `llamacpp`
4. `koboldcpp`
5. `embedded_vllm`
6. `embedded_llamacpp`
7. `cloud` (optional)

Bootstrap provisions local inference dependencies (`local-inference/venv/`) so embedded/local paths can run when selected by policy.

The inference server is launched automatically via `npm run dev` (Windows) or can be
started manually:

```bash
# Unix / macOS
bash scripts/diagnostics/launch-inference.sh

# Windows
scripts\diagnostics\launch-inference.bat
```

The launch scripts resolve the repo root correctly from their own location and look for:

1. A bundled Python binary at `bin/python-mac|linux|portable/`
2. Falling back to `local-inference/venv/bin/python`
3. A `.gguf` model file in `models/`

If neither Python binary nor a model is found, the script exits with a clear diagnostic.

---

## Authentication Panel and Storage Credentials

Storage credentials can be added from the Settings Authentication panel and applied per Provider.

- Authentication panel stores credential material in settings auth keys.
- Applying credentials updates Provider auth state in Storage Registry.
- Layered Validation and assignment diagnostics then use the updated auth state (`blocked_auth_invalid` vs ready states).

---

## Python Dependency Files

| File | Used by |
|---|---|
| `local-inference/requirements.txt` | Local llama-cpp-python inference server |
| `mcp-servers/tala-core/requirements.txt` | Tala core MCP service |
| `mcp-servers/mem0-core/requirements.txt` | Memory MCP service |
| `mcp-servers/astro-engine/requirements.txt` | Astrology/emotion engine |
| `mcp-servers/world-engine/requirements.txt` | World engine (if present) |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Reference/audit only — not used by bootstrap |

---

## Windows / Unix Parity

Both `bootstrap.sh` and `bootstrap.ps1` perform the same logical steps.
Intentional differences:

| Area | Unix | Windows |
|---|---|---|
| Python detection | `python3` then `python` | `python` (Windows installer uses `python`) |
| venv Python binary | `venv/bin/python` | `venv\Scripts\python.exe` |
| Bundled Python dir | `bin/python-mac/` or `bin/python-linux/` | `bin\python-win\` |
| Model download | `curl` or `wget` | `Invoke-WebRequest` |

---

## Portable Build Scripts

These scripts create zero-installation distributable packages. They live in
`scripts/diagnostics/` and all navigate to repo root before running.

| Script | Platform | Purpose |
|---|---|---|
| `scripts/diagnostics/make_portable.sh` | Unix / macOS | Portable build using bundled Python |
| `scripts/diagnostics/make_portable.bat` | Windows | Portable build using Python embeddable |
| `scripts/diagnostics/make_portable_win.bat` | Windows | Portable build using python-build-standalone |
| `scripts/diagnostics/make_universal.bat` | Windows | Cross-platform universal build |
| `scripts/diagnostics/assemble_universal.bat` | Windows | Re-assemble universal build after step 7 failure |
| `scripts/diagnostics/setup_usb.bat` | Windows | Re-install venvs on USB target |

---

## Troubleshooting

### `package.json not found`
You are not running from the repo root.  All scripts now self-resolve their location
so this should not happen.  If you see it, verify the script was not copied to a
different location.

### `Python not found`
Install Python 3.10+ and ensure it is added to `PATH`.  On Windows, re-run the
installer and check "Add Python to PATH".

### `venv missing` from verify-setup
Run `bash bootstrap.sh` (or `.\bootstrap.ps1`) to create the virtual environments.

### `No .gguf model found`
Run `bash bootstrap.sh` to download the default model, or manually place a `.gguf`
file in the `models/` directory.

### `npm install failed` / `postinstall patch-package error`
This can occur in CI or sandboxed environments where native modules cannot be patched.
Run `npm install --ignore-scripts` as a workaround, then apply patches manually if needed.

---

## Known Limitations

- The `npm run dev:inference` script dispatches by platform:
  `scripts\diagnostics\launch-inference.bat` on Windows and
  `scripts/diagnostics/launch-inference.sh` on Linux/macOS.
- `make_portable.sh` requires Python 3.13 to be pre-installed before running — it
  does not download Python automatically on Unix/macOS.
- Cross-platform Electron builds (Linux from Windows) may fail due to native modules.
  Build Linux packages on a Linux machine or via GitHub Actions.
