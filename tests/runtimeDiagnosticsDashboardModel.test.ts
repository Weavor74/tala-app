import { describe, expect, it } from 'vitest';
import { buildDashboardActionViews } from '../src/renderer/components/RuntimeDiagnosticsDashboardModel';
import type { OperatorActionStateSnapshot, RuntimeDiagnosticsSnapshot } from '../shared/runtimeDiagnosticsTypes';

function makeSnapshot(overrides: Partial<RuntimeDiagnosticsSnapshot> = {}): RuntimeDiagnosticsSnapshot {
    const now = '2026-04-14T12:00:00.000Z';
    return {
        timestamp: now,
        inference: {
            selectedProviderReady: true,
            attemptedProviders: [],
            fallbackApplied: false,
            streamStatus: 'idle',
            providerInventorySummary: { total: 1, ready: 1, degraded: 0, unavailable: 0 },
            lastUpdated: now,
        },
        mcp: {
            services: [],
            totalConfigured: 0,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: now,
        },
        degradedSubsystems: [],
        recentFailures: { count: 0, failedEntityIds: [] },
        lastUpdatedPerSubsystem: { inference: now, mcp: now },
        operatorActions: [],
        providerHealthScores: [],
        suppressedProviders: [],
        recentProviderRecoveries: [],
        recentMcpRestarts: [],
        systemHealth: {
            timestamp: now,
            overall_status: 'healthy',
            subsystem_entries: [],
            trust_score: 1,
            degraded_capabilities: [],
            blocked_capabilities: [],
            active_fallbacks: [],
            active_incidents: [],
            pending_repairs: [],
            current_mode: 'NORMAL',
            effective_mode: 'NORMAL',
            active_degradation_flags: [],
            mode_contract: {
                mode: 'NORMAL',
                entry_conditions: [],
                exit_conditions: [],
                allowed_capabilities: [],
                blocked_capabilities: [],
                fallback_behavior: [],
                user_facing_behavior_changes: [],
                telemetry_expectations: [],
                operator_actions_allowed: [],
                autonomy_allowed: true,
                writes_allowed: true,
                operator_approval_required_for: [],
            },
            recent_mode_transitions: [],
            capability_matrix: [],
            active_incident_entries: [],
            trust_explanation: {
                telemetry_freshness: { inference_age_ms: 0, mcp_age_ms: 0, expected_max_age_ms: 90_000 },
                last_successful_subsystem_check: now,
                stale_components: [],
                missing_evidence: [],
                suppressed_assumptions: [],
                confidence_penalties: [],
            },
            trust_score_inputs: {
                inference_age_ms: 0,
                mcp_age_ms: 0,
                expected_max_age_ms: 90_000,
                db_evidence_observed: true,
                telemetry_stream_observed: true,
            },
            operator_attention_required: false,
        },
        ...overrides,
    };
}

function makeOperatorState(): OperatorActionStateSnapshot {
    return {
        actions: [],
        auto_actions: [],
        visibility: {
            acknowledged_incidents: [],
            muted_duplicate_alert_keys: [],
            pinned_issue: null,
            self_improvement_locked: false,
            high_risk_human_approval_required: false,
        },
        available_actions: [
            {
                action: 'retry_inference_probe',
                label: 'Retry Inference Probe',
                category: 'recovery_control',
                risk_level: 'low',
                recommended: true,
                allowed: true,
                reason: 'available',
                requires_explicit_approval: false,
                affected_subsystems: ['inference_service'],
            },
            {
                action: 'enter_safe_mode',
                label: 'Enter Safe Mode',
                category: 'runtime_control',
                risk_level: 'low',
                recommended: true,
                allowed: false,
                reason: 'blocked_by_mode_contract:MAINTENANCE:run_maintenance_checks',
                requires_explicit_approval: false,
                affected_subsystems: ['runtime_mode_manager'],
            },
        ],
    };
}

describe('runtimeDiagnosticsDashboardModel', () => {
    it('uses backend-provided available actions as canonical source', () => {
        const snapshot = makeSnapshot();
        const state = makeOperatorState();
        const view = buildDashboardActionViews(snapshot, state);

        expect(view.contextActions.map((a) => a.id)).toEqual(['retry_inference_probe', 'enter_safe_mode']);
        expect(view.groupedActions.recovery_control.some((a) => a.id === 'retry_inference_probe')).toBe(true);
        expect(view.groupedActions.runtime_control.some((a) => a.id === 'enter_safe_mode' && !a.allowed)).toBe(true);
    });

    it('falls back to deterministic renderer compatibility actions when backend action state is unavailable', () => {
        const snapshot = makeSnapshot({
            systemHealth: {
                ...makeSnapshot().systemHealth,
                subsystem_entries: [
                    {
                        name: 'inference_service',
                        status: 'degraded',
                        severity: 'warning',
                        last_checked_at: '2026-04-14T12:00:00.000Z',
                        last_changed_at: '2026-04-14T12:00:00.000Z',
                        reason_codes: ['inference_fallback_active'],
                        evidence: [],
                        operator_impact: 'reduced',
                        auto_action_state: 'fallback_active',
                        recommended_actions: [],
                    },
                ],
            },
        });
        const view = buildDashboardActionViews(snapshot, null);
        expect(view.contextActions.map((a) => a.id)).toContain('retry_inference_probe');
        expect(view.contextActions.map((a) => a.id)).toContain('enter_safe_mode');
    });
});
