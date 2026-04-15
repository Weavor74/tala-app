# Doclock Impact Report

This document is deterministic and maintained by `tools/doclock/heal-docs.ts`.

## Impact Map
<!-- GENERATED:impact-map:start -->
| Changed Path | Doc Owners | Generated Sections | Mode |
| --- | --- | --- | --- |
| `electron/__tests__/diagnostics/McpAuthorityGovernance.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/__tests__/diagnostics/McpProviderTemplateOnboarding.test.ts` | `docs/review/doclock-impact.md`<br>`docs/traceability/test_trace_matrix.md` | `impact-map` | auto |
| `electron/main.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `electron/preload.ts` | `docs/interfaces/ipc_interface_control.md`<br>`docs/review/doclock-impact.md` | `impact-map`, `ipc-inventory` | auto |
| `electron/services/AgentService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/IpcRouter.ts` | `docs/architecture/service_interactions.md`<br>`docs/interfaces/ipc_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `ipc-inventory`, `service-ownership-map` | auto |
| `electron/services/McpLifecycleManager.ts` | `docs/architecture/service_interactions.md`<br>`docs/interfaces/mcp_interface_control.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/MCP_TOOLS.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `mcp-service-summary`, `service-ownership-map` | auto |
| `electron/services/RuntimeControlService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/RuntimeDiagnosticsAggregator.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/ToolService.ts` | `docs/architecture/service_interactions.md`<br>`docs/features/tool_execution_features.md`<br>`docs/review/doclock-impact.md`<br>`docs/runtime/tool_execution_policy.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map`, `tool-policy-matrix` | auto |
| `electron/services/mcp/McpAuthorityService.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `electron/services/mcp/McpProviderTemplate.ts` | `docs/architecture/service_interactions.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/SERVICES.md` | `impact-map`, `service-ownership-map` | auto |
| `shared/mcpAuthorityTypes.ts` | `docs/review/documentation_gaps.md`<br>`docs/review/doclock-impact.md` | `impact-map` | manual |
| `shared/runtimeDiagnosticsTypes.ts` | `docs/contracts/runtimeDiagnosticsTypes.md`<br>`docs/review/doclock-impact.md`<br>`docs/subsystems/service-RuntimeDiagnosticsAggregator.md` | `impact-map` | auto |
| `shared/settings.ts` | `docs/contracts/settings.md`<br>`docs/interfaces/configuration_contracts.md`<br>`docs/review/doclock-impact.md` | `config-env-matrix`, `impact-map` | auto |

Summary: total_changed=29, impact_candidates=15, mapped=13, unmapped=2, manual_review=2.
<!-- GENERATED:impact-map:end -->

## REVIEW_REQUIRED
<!-- REVIEW_REQUIRED:start -->
- [x] `electron/main.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)
- [x] `shared/mcpAuthorityTypes.ts` -> review/update: docs/review/documentation_gaps.md, docs/review/doclock-impact.md (reason: UNMAPPED_PATH)

Rule: unresolved `[ ]` items block `docs:validate`.
<!-- REVIEW_REQUIRED:end -->
