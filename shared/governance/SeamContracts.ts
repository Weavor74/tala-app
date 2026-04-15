export type CriticalSeamId =
    | 'storage_authority'
    | 'diagnostics_truth_contracts'
    | 'runtime_mode_control'
    | 'workspace_surfaces';

export type SeamStabilityLevel = 'locked';

export type SeamChangeControlLevel = 'strict';

export interface SeamContractDefinition {
    id: CriticalSeamId;
    ownerDomain: string;
    protected: boolean;
    stabilityLevel: SeamStabilityLevel;
    docPath: string;
    requiredInvariants: string[];
    forbiddenBehaviors: string[];
    requiredDiagnosticsFields: string[];
    requiredTestCoverageTags: string[];
    changeControlLevel: SeamChangeControlLevel;
    protectedPathPatterns: string[];
}

export const seamContractMetadataPath = 'shared/governance/SeamContracts.ts';

export const SEAM_CONTRACTS: ReadonlyArray<SeamContractDefinition> = Object.freeze([
    {
        id: 'storage_authority',
        ownerDomain: 'electron/services/storage',
        protected: true,
        stabilityLevel: 'locked',
        docPath: 'docs/contracts/seam-storage-authority.md',
        requiredInvariants: [
            'postgres_is_canonical_authority',
            'pgvector_is_capability_not_authority',
            'assignment_not_equal_readiness',
            'degraded_state_does_not_reassign_canonical_authority',
            'canonical_truth_resolves_to_postgres_backed_ids',
        ],
        forbiddenBehaviors: [
            'silent_canonical_reassignment_on_degraded_or_unreachable_state',
            'vector_capability_claimed_as_authority',
            'durable_memory_write_bypassing_authority_path',
        ],
        requiredDiagnosticsFields: [
            'reason_code',
            'authority_state',
            'unavailable_state',
            'authentication_not_ready_state',
            'capability_missing_state',
            'degraded_authority_state',
        ],
        requiredTestCoverageTags: [
            'seam-storage-authority-contract',
            'seam-storage-authority-doctrine',
        ],
        changeControlLevel: 'strict',
        protectedPathPatterns: [
            '^electron/services/storage/',
            '^electron/services/HybridMemoryManager\\.ts$',
            '^electron/services/MemoryService\\.ts$',
            '^shared/memory/',
            '^shared/runtimeDiagnosticsTypes\\.ts$',
            '^src/renderer/storage/',
            '^src/renderer/components/storage/',
        ],
    },
    {
        id: 'diagnostics_truth_contracts',
        ownerDomain: 'runtime diagnostics + renderer diagnostics surfaces',
        protected: true,
        stabilityLevel: 'locked',
        docPath: 'docs/contracts/seam-diagnostics.md',
        requiredInvariants: [
            'no_healthy_without_evidence',
            'machine_usable_reason_codes_required_for_material_states',
            'evidence_links_explicitly_present_or_marked_unavailable',
            'renderer_cannot_fabricate_backend_truth',
            'diagnostics_summary_tracks_backend_state',
        ],
        forbiddenBehaviors: [
            'optimistic_health_without_backend_evidence',
            'reasonless_degraded_or_unavailable_state',
            'renderer_side_truth_fabrication',
        ],
        requiredDiagnosticsFields: [
            'reason_code',
            'evidence_status',
            'backend_truth_source',
            'degraded_subsystems',
            'last_updated_timestamp',
        ],
        requiredTestCoverageTags: [
            'seam-diagnostics-contract',
            'seam-diagnostics-truth',
        ],
        changeControlLevel: 'strict',
        protectedPathPatterns: [
            '^electron/services/RuntimeDiagnosticsAggregator\\.ts$',
            '^electron/services/InferenceDiagnosticsService\\.ts$',
            '^electron/services/SystemHealthService\\.ts$',
            '^electron/services/OperatorActionService\\.ts$',
            '^shared/runtimeDiagnosticsTypes\\.ts$',
            '^shared/system-health-types\\.ts$',
            '^src/renderer/components/RuntimeDiagnostics',
        ],
    },
    {
        id: 'runtime_mode_control',
        ownerDomain: 'runtime mode + operator governance services',
        protected: true,
        stabilityLevel: 'locked',
        docPath: 'docs/contracts/seam-runtime-mode.md',
        requiredInvariants: [
            'runtime_mode_authority_is_singular_and_backend_owned',
            'renderer_inference_for_authoritative_mode_is_forbidden',
            'unavailable_actions_are_explicit',
            'mode_transitions_preserve_guardrail_governance_semantics',
            'critical_runtime_actions_disallow_best_effort_ambiguity',
        ],
        forbiddenBehaviors: [
            'renderer_authority_inference_for_runtime_mode',
            'implicit_action_availability_for_critical_controls',
            'mode_transition_without_guardrail_semantic_preservation',
        ],
        requiredDiagnosticsFields: [
            'reason_code',
            'mode_authority_source',
            'action_availability_reason',
            'guardrail_state',
            'transition_policy_state',
        ],
        requiredTestCoverageTags: [
            'seam-runtime-mode-contract',
            'seam-runtime-mode-governance',
        ],
        changeControlLevel: 'strict',
        protectedPathPatterns: [
            '^electron/services/SystemModeManager\\.ts$',
            '^electron/services/RuntimeControlService\\.ts$',
            '^electron/services/OperatorActionService\\.ts$',
            '^electron/services/RuntimeSafety\\.ts$',
            '^shared/system-health-types\\.ts$',
            '^shared/runtimeDiagnosticsTypes\\.ts$',
            '^src/renderer/components/AgentModeConfigPanel\\.tsx$',
            '^src/renderer/components/RuntimeDiagnosticsPanel\\.tsx$',
        ],
    },
    {
        id: 'workspace_surfaces',
        ownerDomain: 'renderer workspace surface host + state contracts',
        protected: true,
        stabilityLevel: 'locked',
        docPath: 'docs/contracts/seam-workspace-surfaces.md',
        requiredInvariants: [
            'rendering_controls_persistence_are_separate_responsibilities',
            'controls_are_registered_not_inferred',
            'surface_state_is_serializable_and_versioned',
            'restore_behavior_is_deterministic',
            'invalid_or_unsupported_surface_state_degrades_explicitly',
        ],
        forbiddenBehaviors: [
            'ad_hoc_control_inference_outside_registry_contract',
            'non_serializable_surface_state_persistence',
            'implicit_restore_fallback_without_degraded_reason',
        ],
        requiredDiagnosticsFields: [
            'reason_code',
            'surface_state_version',
            'registered_surface_key',
            'restore_outcome',
            'degraded_surface_state',
        ],
        requiredTestCoverageTags: [
            'seam-workspace-surfaces-contract',
            'seam-workspace-surfaces-restore',
        ],
        changeControlLevel: 'strict',
        protectedPathPatterns: [
            '^src/renderer/workspace/',
            '^src/renderer/A2UIWorkspaceSurface\\.tsx$',
            '^src/renderer/components/CoreWorkspace\\.tsx$',
            '^electron/services/A2UIWorkspaceRouter\\.ts$',
            '^shared/a2uiTypes\\.ts$',
        ],
    },
]);

export const SEAM_CONTRACT_DOC_PATHS: ReadonlyArray<string> = Object.freeze(
    SEAM_CONTRACTS.map((contract) => contract.docPath)
);

export function listCriticalSeamIds(): CriticalSeamId[] {
    return SEAM_CONTRACTS.map((contract) => contract.id);
}

export function getSeamContractById(id: CriticalSeamId): SeamContractDefinition | undefined {
    return SEAM_CONTRACTS.find((contract) => contract.id === id);
}
