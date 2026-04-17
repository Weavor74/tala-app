import { describe, expect, it } from 'vitest';
import {
    buildDashboardActionViews,
    buildAuthorityLaneDiagnosticsView,
    ALL_AUTHORITY_LANES,
    AUTHORITY_LANE_LABELS,
} from '../src/renderer/components/RuntimeDiagnosticsDashboardModel';
import type { OperatorActionStateSnapshot, RuntimeDiagnosticsSnapshot, AuthorityLaneDiagnosticsSnapshot } from '../shared/runtimeDiagnosticsTypes';
import type { AuthorityLaneDiagnosticsRecord } from '../shared/planning/executionAuthorityTypes';

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
        expect(view.controlsUnavailable).toBe(false);
    });

    it('reports explicit controls-unavailable state when backend action state is unavailable', () => {
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
        expect(view.contextActions).toEqual([]);
        expect(view.controlsUnavailable).toBe(true);
        expect(view.controlsUnavailableReason).toBe('operator_action_availability_unavailable');
    });
});

// ─── Helpers for authority lane UI model tests ────────────────────────────────

function makeAuthorityRecord(overrides: Partial<AuthorityLaneDiagnosticsRecord> = {}): AuthorityLaneDiagnosticsRecord {
    return {
        authorityLane: 'planning_loop',
        routingClassification: 'planning_loop_required',
        reasonCodes: ['tool_signal_detected'],
        loopId: 'loop-test-001',
        executionBoundaryId: 'exec-test-001',
        policyOutcome: 'allowed',
        resolvedAt: '2026-04-17T01:00:00.000Z',
        summary: 'planning_loop: loop completed (loopId=loop-test-001)',
        ...overrides,
    };
}

function makeAuthoritySnapshot(
    record: AuthorityLaneDiagnosticsRecord,
    countsOverride: Partial<Record<string, number>> = {},
    degradedDirectCount = 0,
): AuthorityLaneDiagnosticsSnapshot {
    return {
        lastRecord: record,
        lastUpdated: '2026-04-17T01:00:00.000Z',
        laneResolutionCounts: { [record.authorityLane]: 1, ...countsOverride },
        degradedDirectCount,
    };
}

// ─── EAUV-01..12: Execution Authority UI model tests ─────────────────────────

describe('EAUV-01..12: buildAuthorityLaneDiagnosticsView — deterministic UI model', () => {
    it('EAUV-01: returns null when executionAuthority is absent from snapshot', () => {
        const snap = makeSnapshot();
        expect(buildAuthorityLaneDiagnosticsView(snap)).toBeNull();
    });

    it('EAUV-02: returns a view when executionAuthority is present', () => {
        const snap = makeSnapshot({
            executionAuthority: makeAuthoritySnapshot(makeAuthorityRecord()),
        });
        expect(buildAuthorityLaneDiagnosticsView(snap)).not.toBeNull();
    });

    it('EAUV-03: currentLane matches lastRecord.authorityLane', () => {
        const record = makeAuthorityRecord({ authorityLane: 'trivial_direct', routingClassification: 'trivial_direct_allowed', reasonCodes: [], loopId: undefined });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.currentLane).toBe('trivial_direct');
    });

    it('EAUV-04: currentLaneLabel is the human-readable lane label from AUTHORITY_LANE_LABELS', () => {
        const record = makeAuthorityRecord({ authorityLane: 'planning_loop' });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.currentLaneLabel).toBe(AUTHORITY_LANE_LABELS['planning_loop']);
    });

    it('EAUV-05: routingClassification matches lastRecord.routingClassification', () => {
        const record = makeAuthorityRecord({ routingClassification: 'doctrined_exception' });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.routingClassification).toBe('doctrined_exception');
    });

    it('EAUV-06: policyOutcome, loopId, executionBoundaryId, resolvedAt, summary are passed through', () => {
        const record = makeAuthorityRecord();
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.policyOutcome).toBe(record.policyOutcome);
        expect(view.loopId).toBe(record.loopId);
        expect(view.executionBoundaryId).toBe(record.executionBoundaryId);
        expect(view.resolvedAt).toBe(record.resolvedAt);
        expect(view.summary).toBe(record.summary);
    });

    it('EAUV-07: reasonCodes array matches lastRecord.reasonCodes', () => {
        const record = makeAuthorityRecord({ reasonCodes: ['tool_signal_detected', 'multi_step_signal_detected'] });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.reasonCodes).toEqual(['tool_signal_detected', 'multi_step_signal_detected']);
    });

    it('EAUV-08: degradedDecision is undefined when lastRecord has no degradedExecutionDecision', () => {
        const record = makeAuthorityRecord();
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.degradedDecision).toBeUndefined();
    });

    it('EAUV-09: degradedDecision is projected from degradedExecutionDecision when present', () => {
        const record = makeAuthorityRecord({
            authorityLane: 'chat_continuity_degraded_direct',
            degradedExecutionDecision: {
                reason: 'loop_unavailable',
                directAllowed: true,
                degradedModeCode: 'degraded_direct_allowed',
                doctrine: 'chat_continuity: loop was unavailable — direct path permitted',
                detectedIn: 'AgentKernel.execute',
                detectedAt: '2026-04-17T01:00:00.000Z',
            },
        });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record, {}, 1) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.degradedDecision).toBeDefined();
        expect(view.degradedDecision!.reason).toBe('loop_unavailable');
        expect(view.degradedDecision!.directAllowed).toBe(true);
        expect(view.degradedDecision!.degradedModeCode).toBe('degraded_direct_allowed');
        expect(view.degradedDecision!.doctrine).toContain('chat_continuity');
        expect(view.degradedDecision!.detectedIn).toBe('AgentKernel.execute');
    });

    it('EAUV-10: laneResolutionCounts covers all five doctrined lanes — zero for absent lanes', () => {
        const record = makeAuthorityRecord({ authorityLane: 'planning_loop' });
        const snap = makeSnapshot({
            executionAuthority: makeAuthoritySnapshot(record, { planning_loop: 3, trivial_direct: 1 }),
        });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.laneResolutionCounts['planning_loop']).toBe(3);
        expect(view.laneResolutionCounts['trivial_direct']).toBe(1);
        expect(view.laneResolutionCounts['chat_continuity_degraded_direct']).toBe(0);
        expect(view.laneResolutionCounts['autonomy_safechangeplanner_pipeline']).toBe(0);
        expect(view.laneResolutionCounts['operator_policy_gate']).toBe(0);
        // All five lanes are always present
        expect(Object.keys(view.laneResolutionCounts).sort()).toEqual(ALL_AUTHORITY_LANES.slice().sort());
    });

    it('EAUV-11: degradedDirectCount matches snapshot.executionAuthority.degradedDirectCount', () => {
        const record = makeAuthorityRecord({ authorityLane: 'chat_continuity_degraded_direct' });
        const snap = makeSnapshot({ executionAuthority: makeAuthoritySnapshot(record, {}, 4) });
        const view = buildAuthorityLaneDiagnosticsView(snap)!;
        expect(view.degradedDirectCount).toBe(4);
    });

    it('EAUV-12: all five AUTHORITY_LANE_LABELS entries have non-empty strings', () => {
        for (const lane of ALL_AUTHORITY_LANES) {
            expect(typeof AUTHORITY_LANE_LABELS[lane]).toBe('string');
            expect(AUTHORITY_LANE_LABELS[lane].length).toBeGreaterThan(0);
        }
        expect(ALL_AUTHORITY_LANES).toHaveLength(5);
    });
});
