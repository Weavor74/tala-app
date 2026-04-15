import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../electron/services/IpcRouter';
import { OperatorActionService } from '../electron/services/OperatorActionService';

const mocked = vi.hoisted(() => ({
    telemetryEmit: vi.fn(),
    auditInfo: vi.fn(),
    policyCheckSideEffect: vi.fn(() => ({ allowed: true, reason: 'ok' })),
}));

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: mocked.telemetryEmit,
        }),
    },
}));

vi.mock('../electron/services/AuditLogger', () => ({
    auditLogger: {
        info: mocked.auditInfo,
    },
}));

vi.mock('../electron/services/policy/PolicyGate', () => ({
    policyGate: {
        checkSideEffect: mocked.policyCheckSideEffect,
    },
}));

function makeHealth(overrides: Record<string, unknown> = {}): any {
    return {
        timestamp: '2026-04-15T13:00:00.000Z',
        overall_status: 'healthy',
        subsystem_entries: [],
        active_incident_entries: [],
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

function makeService() {
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
        getOperatorModeOverride: () => (overrideMode ? { mode: overrideMode, setAt: '2026-04-15T13:00:00.000Z' } : null),
        getSnapshot: () => ({
            inference: { selectedProviderId: null },
            mcp: { services: [] },
        }),
    };
    const runtimeControl: any = {
        probeProviders: vi.fn(async () => ({ success: true })),
        probeMcpServices: vi.fn(() => ({ success: true })),
        restartMcpService: vi.fn(async () => ({ success: true })),
        restartProvider: vi.fn(async () => ({ success: true })),
    };
    return {
        service: new OperatorActionService({
            diagnosticsAggregator,
            runtimeControl,
            getSettingsPath: () => 'D:/tmp/operator-integration-settings.json',
        }),
        diagnosticsAggregator,
        runtimeControl,
    };
}

function makeRouterContext(service: OperatorActionService): any {
    return {
        app: {},
        getMainWindow: () => null,
        agent: { setDiagnosticsAggregator: vi.fn(), setWorkspaceRoot: vi.fn() },
        fileService: { getRoot: vi.fn(() => null) },
        terminalService: { setRoot: vi.fn() },
        systemService: {},
        mcpService: {},
        functionService: {},
        workflowService: { listWorkflows: vi.fn(() => []), saveRun: vi.fn() },
        workflowEngine: { setDebugCallback: vi.fn(), executeWorkflow: vi.fn(async () => ({ success: true, logs: [], context: {} })) },
        guardrailService: {},
        gitService: {},
        backupService: {},
        inferenceService: {},
        userProfileService: {},
        codeControlService: {},
        logViewerService: {},
        diagnosticsAggregator: {
            getSnapshot: vi.fn(() => ({ inference: { selectedProviderId: null }, mcp: { services: [] } })),
            getSystemHealthSnapshot: vi.fn(() => makeHealth()),
            getSystemModeSnapshot: vi.fn(() => ({
                effective_mode: 'NORMAL',
                active_degradation_flags: [],
                mode_contract: { mode: 'NORMAL' },
                recent_mode_transitions: [],
            })),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
        },
        runtimeControl: {},
        operatorActionService: service,
        worldModelAssembler: undefined,
        maintenanceLoopService: undefined,
        getSettingsPath: () => 'D:/tmp/tala-test-settings.json',
        setSettingsPath: vi.fn(),
        USER_DATA_DIR: 'D:/tmp/user-data',
        USER_DATA_PATH: 'D:/tmp/user-data/app_settings.json',
        APP_DIR: 'D:/tmp/app',
        PORTABLE_SETTINGS_PATH: 'D:/tmp/portable/settings.json',
        SYSTEM_SETTINGS_PATH: 'D:/tmp/system/settings.json',
        TEMP_SYSTEM_PATH: 'D:/tmp/system',
    };
}

describe('Operator override/rollback integration', () => {
    const handlers = new Map<string, (...args: any[]) => any>();

    beforeEach(() => {
        mocked.telemetryEmit.mockClear();
        mocked.auditInfo.mockClear();
        mocked.policyCheckSideEffect.mockReset();
        mocked.policyCheckSideEffect.mockReturnValue({ allowed: true, reason: 'ok' });
        handlers.clear();
        (ipcMain as any).handle = vi.fn((channel: string, handler: (...args: any[]) => any) => {
            handlers.set(channel, handler);
        });
        (ipcMain as any).on = vi.fn();
        (ipcMain as any).removeHandler = vi.fn();
    });

    it('denied action stays denied across backend and IPC surfaces', async () => {
        const { service } = makeService();
        await service.executeAction({
            action: 'require_human_approval_high_risk',
            requested_by: 'operator',
            params: { required: true },
        });
        const backendDenied = await service.executeAction({
            action: 'exit_safe_mode',
            requested_by: 'operator',
        });
        expect(backendDenied.allowed).toBe(false);
        expect(backendDenied.reason).toBe('human_approval_required_for_high_risk_action');

        const router = new IpcRouter(makeRouterContext(service));
        router.registerAll();
        const handler = handlers.get('operator:executeAction');
        const ipcDenied = await handler?.({}, {
            action: 'exit_safe_mode',
            requested_by: 'renderer',
        });
        expect(ipcDenied.allowed).toBe(false);
        expect(ipcDenied.reason).toBe('human_approval_required_for_high_risk_action');
    });

    it('override path requires explicit approval and is audited', async () => {
        const { service } = makeService();
        await service.executeAction({
            action: 'require_human_approval_high_risk',
            requested_by: 'operator',
            params: { required: true },
        });
        const denied = await service.executeAction({
            action: 'clear_maintenance_mode',
            requested_by: 'operator',
        });
        const approved = await service.executeAction({
            action: 'clear_maintenance_mode',
            requested_by: 'operator',
            params: { operator_approved: true },
        });

        expect(denied.allowed).toBe(false);
        expect(approved.allowed).toBe(false);
        expect(approved.reason).toBe('maintenance_override_not_active');
        expect(mocked.auditInfo).toHaveBeenCalled();
    });

    it('risky action under explicit override returns rollback-capable result', async () => {
        const { service } = makeService();
        await service.executeAction({
            action: 'require_human_approval_high_risk',
            requested_by: 'operator',
            params: { required: true },
        });
        const result = await service.executeAction({
            action: 'enter_safe_mode',
            requested_by: 'operator',
            params: { operator_approved: true },
        });

        expect(result.allowed).toBe(true);
        expect(result.rollback_availability).toBe('manual');
        expect(result.resulting_mode_change).toEqual({
            from_mode: 'NORMAL',
            to_mode: 'SAFE_MODE',
        });
    });

    it('rollback after partial change can succeed and failure remains explicit when unavailable', async () => {
        const { service } = makeService();
        const enter = await service.executeAction({
            action: 'enter_safe_mode',
            requested_by: 'operator',
        });
        const rollback = await service.executeAction({
            action: 'exit_safe_mode',
            requested_by: 'operator',
        });
        const secondRollback = await service.executeAction({
            action: 'exit_safe_mode',
            requested_by: 'operator',
        });

        expect(enter.allowed).toBe(true);
        expect(rollback.allowed).toBe(true);
        expect(rollback.resulting_mode_change).toEqual({
            from_mode: 'SAFE_MODE',
            to_mode: 'NORMAL',
        });
        expect(secondRollback.allowed).toBe(false);
        expect(secondRollback.reason).toBe('safe_mode_override_not_active');
    });

    it('missing action metadata never creates permissive fallback', async () => {
        const { service } = makeService();
        const missingProposal = await service.executeAction({
            action: 'approve_repair_proposal',
            requested_by: 'operator',
        });
        const unknown = await service.executeAction({
            action: 'unknown_action' as any,
            requested_by: 'operator',
        });

        expect(missingProposal.allowed).toBe(false);
        expect(missingProposal.reason).toBe('missing_proposal_id');
        expect(unknown.allowed).toBe(false);
        expect(unknown.reason).toBe('unknown_action');
    });
});

