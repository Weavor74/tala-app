# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/services/ArtifactRouter.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/types/artifacts.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `package-lock.json` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `package.json` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |
| `src/App.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/types.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceBoardModel.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceContentTypeResolver.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceDocumentFactory.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceSurfaceHelpers.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceSurfaceHost.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/WorkspaceSurfaceRegistry.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/BoardSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/FallbackSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/HtmlSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/ImageSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/PdfSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/RtfSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/TextEditorSurface.tsx` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `src/renderer/workspace/surfaces/WorkspaceSurfaceTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `tests/WorkspaceSurfaceRouting.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |

Summary: total_changed=25, impact_candidates=21, mapped=3, unmapped=18, manual_review=18.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `electron/types/artifacts.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `package-lock.json` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/App.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/types.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceBoardModel.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceContentTypeResolver.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceDocumentFactory.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceSurfaceHelpers.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceSurfaceHost.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/WorkspaceSurfaceRegistry.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/BoardSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/FallbackSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/HtmlSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/ImageSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/PdfSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/RtfSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/TextEditorSurface.tsx` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `src/renderer/workspace/surfaces/WorkspaceSurfaceTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
