# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `bootstrap.sh` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `mcp-servers/tala-core/debug_chroma.py` | `docs/interfaces/mcp_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/MCP_TOOLS.md` | `impact-map`, `mcp-service-summary` | auto |
| `package-lock.json` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `package.json` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `scripts/setup-mcp-venvs.ps1` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `scripts/setup-mcp-venvs.sh` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |

Summary: total_changed=7, impact_candidates=6, mapped=4, unmapped=2, manual_review=2.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `bootstrap.sh` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `package-lock.json` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
