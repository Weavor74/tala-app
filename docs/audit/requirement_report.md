# Tala Requirement and Usage Report

This report categorizes repository items as required, unused, or uncertain based on the current audit.

## Required Components

| Component | Reason |
| :--- | :--- |
| `electron/` | Core application framework and backend logic. |
| `src/` | Primary user interface. |
| `mcp-servers/` | Essential services for agent functionality (Memory, RAG, Astro). |
| `local-inference/` | Required for offline model execution. |
| `bin/` | Contains necessary binaries (`llama.cpp`) and the bundled Python distribution. |
| `data/` | Persistent user settings and memory. |
| `package.json` | Root build and dependency manifest. |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Root Python dependency manifest. |

## Candidate Unused Items (Safe to Archive/Delete)

These items do not appear to be referenced by the main application flow or build scripts.

| Path | Description |
| :--- | :--- |
| `archive/` | Historical artifacts and old test databases. |
| `temp_scripts/` | One-off verification and diagnostic scripts. |
| `tests/reflection/` | Legacy Vitest tests (superseded by `electron/__tests__/reflection/`). |
| `agent_profiles.json` (root) | Likely legacy; current profiles are in `mcp-servers/astro-engine/`. |
| `.agent_response_marker` | Residual file from previous agent runs. |
| `llama_help.txt` (root) | Documentation dump, not required for runtime. |
| `testToolService.js` | Legacy JS test file. |
| `test_*.js` / `test_*.txt` | Various ad-hoc test artifacts in root. |

## Uncertain / Manual Items

Review required before removal.

| Path | Description |
| :--- | :--- |
| `REFLECTION_SYSTEM/` | Appears to contain original logic that might have been migrated to Electron services. |
| `tala_project/` | Contains some documentation (`memory_graph.md`); status unclear. |
| `verify_*.ts` (root) | Manual verification scripts used by developers. |
| `missing_symbol_audit.*` | Recent audit files; status unknown if still needed. |

> [!WARNING]
> Manual scripts (`verify_*.ts`) should not be deleted if they are used in CI/CD or manual release verification steps.
