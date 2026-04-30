# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/services/AgentService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/InferenceService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/RagService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/ToolService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/tool_execution_features.md`<br>`docs/review/doclock-impact.md`<br>`docs/runtime/tool_execution_policy.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map`, `tool-policy-matrix` | auto |
| `electron/services/inference/InferenceProviderRegistry.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/router/ContextAssembler.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/router/TalaContextRouter.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `scripts/diagnostics/launch-inference.bat` | `docs/build/maintenance_guidelines.md`<br>`docs/development/self_maintenance.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `shared/inferenceProviderTypes.ts` | `docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `shared/ragStartupTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `tests/InferenceWindowsPreflight.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/RagServiceReadinessTruth.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/ToolServiceMcpRefreshSignature.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |

Summary: total_changed=18, impact_candidates=13, mapped=12, unmapped=1, manual_review=1.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [ ] `shared/ragStartupTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
