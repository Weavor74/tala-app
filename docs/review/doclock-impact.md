# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/__tests__/diagnostics/SystemHealthService.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/main.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `electron/services/IpcRouter.ts` | `docs/architecture/service_interactions.md`<br>`docs/interfaces/ipc_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `ipc-inventory`, `service-ownership-map` | auto |
| `electron/services/RuntimeControlService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/SystemModeManager.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/tools/ToolExecutionCoordinator.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/tool_execution_features.md`<br>`docs/review/doclock-impact.md`<br>`docs/runtime/tool_execution_policy.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map`, `tool-policy-matrix` | auto |

Summary: total_changed=10, impact_candidates=6, mapped=5, unmapped=1, manual_review=1.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `electron/main.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
