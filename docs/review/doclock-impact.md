# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/__tests__/storage/StorageIpcRouter.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/storage/StorageLegacyBootstrap.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/storage/StorageProviderRegistryService.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/services/storage/StorageAssignmentPolicyService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/storage/StorageProviderRegistryService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/storage/storageConfigPersistence.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/storage/storageTypes.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `shared/runtimeDiagnosticsTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/components/storage/StorageSettingsScreen.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/storage/StorageScreenModel.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/storage/StorageViewModels.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/storage/storageTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `tests/storage/StorageRendererModel.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |

Summary: total_changed=17, impact_candidates=13, mapped=8, unmapped=5, manual_review=5.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `shared/runtimeDiagnosticsTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/components/storage/StorageSettingsScreen.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/storage/StorageScreenModel.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/storage/StorageViewModels.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/storage/storageTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
