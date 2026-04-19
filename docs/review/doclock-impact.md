# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/__tests__/cognitive/ModelCapabilityClassifier.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/inference/ModelSelectionIntegration.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/inference/ProviderDetection.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/inference/ProviderInventoryMigration.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/inference/ProviderSelection.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/inference/StartupDiagnosticsProviderTruth.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/ipc/IPCParity.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/settings/ModelSettingsPersistence.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/preload.ts` | `docs/interfaces/ipc_interface_control.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `ipc-inventory` | auto |
| `electron/services/AgentService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/InferenceService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/IpcRouter.ts` | `docs/architecture/service_interactions.md`<br>`docs/interfaces/ipc_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `ipc-inventory`, `service-ownership-map` | auto |
| `electron/services/cognitive/ModelCapabilityClassifier.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/inference/InferenceProviderRegistry.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/inference/ProviderSelectionService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `config-env-matrix`, `impact-map`, `service-ownership-map` | auto |
| `electron/services/memory/MemoryProviderResolver.ts` | `docs/architecture/memory-authority-invariant.md`<br>`docs/architecture/service_interactions.md`<br>`docs/development/memory_purge.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `migration-ledger`, `service-ownership-map` | manual |
| `shared/inferenceProviderTypes.ts` | `docs/features/inference_engine_features.md`<br>`docs/interfaces/inference_interface_control.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `shared/settings.ts` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `src/renderer/Settings.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |

Summary: total_changed=25, impact_candidates=19, mapped=18, unmapped=1, manual_review=2.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `electron/services/memory/MemoryProviderResolver.ts` -> review/update: docs/architecture/memory-authority-invariant.md, docs/architecture/service_interactions.md, docs/development/memory_purge.md, docs/review/doclock-impact.md, docs/subsystems/SERVICES.md (reason: MANUAL_REVIEW_REQUIRED)
- [x] `src/renderer/Settings.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
