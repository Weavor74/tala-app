import { describe, it, expect, vi } from 'vitest';
import { OperatorActionService } from '../../services/OperatorActionService';

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
    it('enters safe mode and returns a deterministic action contract', async () => {
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
        expect(result.action_id).toBe('enter_safe_mode');
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
    });
});

