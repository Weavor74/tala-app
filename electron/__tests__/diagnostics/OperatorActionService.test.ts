import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorActionService } from '../../services/OperatorActionService';

const mocked = vi.hoisted(() => ({
    telemetryEmit: vi.fn(),
    auditInfo: vi.fn(),
    policyCheckSideEffect: vi.fn(() => ({ allowed: true, reason: 'ok' })),
}));

vi.mock('../../services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: mocked.telemetryEmit,
        }),
    },
}));

vi.mock('../../services/AuditLogger', () => ({
    auditLogger: {
        info: mocked.auditInfo,
    },
}));

vi.mock('../../services/policy/PolicyGate', () => ({
    policyGate: {
        checkSideEffect: mocked.policyCheckSideEffect,
    },
}));

const telemetryEmit = mocked.telemetryEmit;
const auditInfo = mocked.auditInfo;
const policyCheckSideEffect = mocked.policyCheckSideEffect;

function makeHealth(overrides: Record<string, unknown> = {}): any {
    return {
        timestamp: new Date().toISOString(),
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
            operator_actions_allowed: ['resume_autonomy', 'run_maintenance_checks', 'exit_maintenance', 'revalidate_authority'],
            autonomy_allowed: true,
            writes_allowed: true,
            operator_approval_required_for: [],
        },
        recent_mode_transitions: [],
        operator_attention_required: false,
        ...overrides,
    };
}

describe('OperatorActionService', () => {
    beforeEach(() => {
        telemetryEmit.mockClear();
        auditInfo.mockClear();
        policyCheckSideEffect.mockReset();
        policyCheckSideEffect.mockReturnValue({ allowed: true, reason: 'ok' });
    });

    it('returns deterministic allowed contract and mode delta for enter_safe_mode', async () => {
        let health = makeHealth();
        let overrideMode: string | null = null;
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => health,
            setOperatorModeOverride: (mode: string | null) => {
                overrideMode = mode;
                health = makeHealth({
                    effective_mode: mode ?? 'NORMAL',
                    current_mode: mode ?? 'NORMAL',
                });
            },
            getOperatorModeOverride: () => (overrideMode ? { mode: overrideMode, setAt: new Date().toISOString() } : null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };

        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };

        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        const result = await service.executeAction({
            action: 'enter_safe_mode',
            requested_by: 'test_operator',
        });

        expect(result.allowed).toBe(true);
        expect(result.action).toBe('enter_safe_mode');
        expect(result.action_id.length).toBeGreaterThan(10);
        expect(result.resulting_mode_change).toEqual({
            from_mode: 'NORMAL',
            to_mode: 'SAFE_MODE',
        });
    });

    it('denies high-risk action when explicit approval is required', async () => {
        let health = makeHealth();
        let overrideMode: string | null = null;
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => health,
            setOperatorModeOverride: (mode: string | null) => {
                overrideMode = mode;
                health = makeHealth({
                    effective_mode: mode ?? 'NORMAL',
                    current_mode: mode ?? 'NORMAL',
                });
            },
            getOperatorModeOverride: () => (overrideMode ? { mode: overrideMode, setAt: new Date().toISOString() } : null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        await service.executeAction({
            action: 'enter_safe_mode',
            requested_by: 'test_operator',
        });
        await service.executeAction({
            action: 'require_human_approval_high_risk',
            requested_by: 'test_operator',
            params: { required: true },
        });

        const denied = await service.executeAction({
            action: 'exit_safe_mode',
            requested_by: 'test_operator',
        });

        expect(denied.allowed).toBe(false);
        expect(denied.reason).toContain('human_approval_required_for_high_risk_action');
        expect(denied.action).toBe('exit_safe_mode');
    });

    it('writes audit and telemetry traces for allowed and denied actions', async () => {
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => makeHealth(),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        await service.executeAction({
            action: 'mute_duplicate_alerts',
            requested_by: 'audit_test_operator',
            params: { alert_key: 'dup-1' },
        });

        policyCheckSideEffect.mockReturnValueOnce({ allowed: false, reason: 'policy_test_denied' });
        await service.executeAction({
            action: 'pin_active_issue',
            requested_by: 'audit_test_operator',
            params: { issue_id: 'inc-1' },
        });

        expect(auditInfo).toHaveBeenCalled();
        const events = auditInfo.mock.calls.map((c) => c[0]);
        expect(events).toContain('operator_action_executed');
        expect(events).toContain('operator_action_denied');
        expect(telemetryEmit).toHaveBeenCalled();
    });

    it('separates auto-repair actions from operator history', async () => {
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => makeHealth(),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        const autoResult = await service.executeAutoAction('mute_duplicate_alerts', { alert_key: 'dup-auto' });
        expect(autoResult.source).toBe('auto_repair');
        expect(service.getAutoRepairHistory().length).toBe(1);
        expect(service.getActionHistory().length).toBe(0);
    });

    it('computes backend action availability with deterministic recommendations', async () => {
        const health = makeHealth({
            subsystem_entries: [
                {
                    name: 'inference_service',
                    status: 'degraded',
                    severity: 'warning',
                    last_checked_at: new Date().toISOString(),
                    last_changed_at: new Date().toISOString(),
                    reason_codes: ['inference_fallback_active'],
                    evidence: [],
                    operator_impact: 'reduced',
                    auto_action_state: 'fallback_active',
                    recommended_actions: [],
                },
            ],
            mode_contract: {
                ...makeHealth().mode_contract,
                mode: 'DEGRADED_INFERENCE',
                operator_actions_allowed: ['probe_providers', 'restart_provider', 'force_provider_selection'],
            },
            effective_mode: 'DEGRADED_INFERENCE',
            current_mode: 'DEGRADED_INFERENCE',
        });
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => health,
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        const actions = service.getAvailableActions();
        const retryProbe = actions.find((a) => a.action === 'retry_inference_probe');
        expect(retryProbe?.recommended).toBe(true);
        expect(retryProbe?.allowed).toBe(true);
    });

    it('marks high-risk actions as approval-required when policy is enabled', async () => {
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => makeHealth(),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        await service.executeAction({
            action: 'require_human_approval_high_risk',
            requested_by: 'test_operator',
            params: { required: true },
        });
        const actions = service.getAvailableActions();
        const exitSafe = actions.find((a) => a.action === 'exit_safe_mode');
        expect(exitSafe?.requires_explicit_approval).toBe(true);
        expect(exitSafe?.allowed).toBe(false);
        expect(exitSafe?.reason).toContain('human_approval_required_for_high_risk_action');
    });

    it('explicitly denies rerun_derived_rebuild when rebuild service is unavailable', async () => {
        const diagnosticsAggregator: any = {
            getSystemHealthSnapshot: () => makeHealth(),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
            getSnapshot: () => ({ inference: {}, mcp: { services: [] } }),
        };
        const runtimeControl: any = {
            probeProviders: vi.fn(async () => ({ success: true })),
            probeMcpServices: vi.fn(() => ({ success: true })),
            restartMcpService: vi.fn(async () => ({ success: true })),
        };
        const service = new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/not-used-settings.json',
        });

        const result = await service.executeAction({
            action: 'rerun_derived_rebuild',
            requested_by: 'closure_test_operator',
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('rebuild_service_unavailable');
        const available = service.getAvailableActions().find((a) => a.action === 'rerun_derived_rebuild');
        expect(available?.allowed).toBe(false);
        expect(available?.reason).toBe('rebuild_service_unavailable');
    });
});
