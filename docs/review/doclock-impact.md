# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `.github/workflows/phase-c-integration.yml` | `docs/development/self_maintenance.md`<br>`docs/operations/naming-maintenance-protocol.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `workflow-registry` | auto |
| `electron/services/RuntimeDiagnosticsAggregator.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/execution/OutcomeEvaluationService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/planning/ChatLoopObserver.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/planning/PlanBuilder.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/planning/PlanExecutionCoordinator.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `package.json` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `shared/execution/CompletionEvidenceTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `shared/planning/PlanningTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `shared/planning/SuccessCriteriaTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `shared/release/QuarantinedTestMetadata.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `shared/runtimeDiagnosticsTypes.ts` | `docs/contracts/runtimeDiagnosticsTypes.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/service-RuntimeDiagnosticsAggregator.md` | `impact-map` | auto |
| `shared/runtimeEventTypes.ts` | `docs/contracts/telemetry.md`<br>`docs/review/doclock-impact.md`<br>`docs/security/logging_and_audit.md` | `impact-map`, `telemetry-event-catalog` | auto |
| `tests/ChatLoopExecutor.planExecution.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/ExecutionIsolation.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/PlanExecutionCoordinator.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/execution/ExecutionOutcomeIntegration.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/execution/OutcomeEvaluationService.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/governance/Phase1QuarantineContract.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `tests/governance/Phase1QuarantinedTests.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `tests/governance/Phase1ReleaseGate.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `tests/planning/SuccessCriteriaGeneration.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |

Summary: total_changed=24, impact_candidates=22, mapped=16, unmapped=6, manual_review=6.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `shared/execution/CompletionEvidenceTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `shared/planning/PlanningTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `shared/planning/SuccessCriteriaTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `shared/release/QuarantinedTestMetadata.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `tests/governance/Phase1QuarantinedTests.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `tests/governance/Phase1ReleaseGate.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
