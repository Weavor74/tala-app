# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `.agents/skills/doc-healer/SKILL.md` | `docs/agent_working_rules.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `.github/workflows/docs-lock.yml` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `.github/workflows/docs-self-heal.yml` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `AGENTS.md` | `docs/agent_working_rules.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `package.json` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `scripts/diagnostics/validate_docs_drift.ts` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `tools/doclock/heal-docs.ts` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `tools/doclock/scan-impact.ts` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `tools/doclock/validate-docs.ts` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |

Summary: total_changed=10, impact_candidates=9, mapped=9, unmapped=0, manual_review=2.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `.agents/skills/doc-healer/SKILL.md` -> review/update: docs/agent_working_rules.md, docs/review/doclock-impact.md (reason: MANUAL_REVIEW_REQUIRED)
- [x] `AGENTS.md` -> review/update: docs/agent_working_rules.md, docs/review/doclock-impact.md (reason: MANUAL_REVIEW_REQUIRED)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
