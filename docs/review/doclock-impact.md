# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/brains/OllamaBrain.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `electron/services/AgentService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/BackupService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/FileService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/InferenceService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/LocalEngineService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/SystemService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/TerminalService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/ToolService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/tool_execution_features.md`<br>`docs/review/doclock-impact.md`<br>`docs/runtime/tool_execution_policy.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map`, `tool-policy-matrix` | auto |
| `electron/services/db/MigrationRunner.ts` | `docs/architecture/memory-authority-invariant.md`<br>`docs/architecture/service_interactions.md`<br>`docs/development/memory_purge.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `migration-ledger`, `service-ownership-map` | manual |
| `electron/services/inference/InferenceProviderRegistry.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/reflection/ReflectionService.ts` | `docs/architecture/phase4b_self_maintenance_foundation.md`<br>`docs/architecture/service_interactions.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map`, `workflow-registry` | manual |
| `scripts/bootstrap-vllm.ps1` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `scripts/bootstrap-vllm.sh` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `scripts/setup-mcp-venvs.ps1` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `scripts/setup-mcp-venvs.sh` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |

Summary: total_changed=19, impact_candidates=16, mapped=15, unmapped=1, manual_review=3.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `electron/brains/OllamaBrain.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `electron/services/db/MigrationRunner.ts` -> review/update: docs/architecture/memory-authority-invariant.md, docs/architecture/service_interactions.md, docs/development/memory_purge.md, docs/review/doclock-impact.md, docs/subsystems/SERVICES.md (reason: MANUAL_REVIEW_REQUIRED)
- [x] `electron/services/reflection/ReflectionService.ts` -> review/update: docs/architecture/phase4b_self_maintenance_foundation.md, docs/architecture/service_interactions.md, docs/development/self_maintenance.md, docs/review/doclock-impact.md, docs/subsystems/SERVICES.md (reason: MANUAL_REVIEW_REQUIRED)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
