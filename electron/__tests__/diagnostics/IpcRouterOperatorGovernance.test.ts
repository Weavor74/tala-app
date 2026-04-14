import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../../services/IpcRouter';
import { SystemModeManager } from '../../services/SystemModeManager';

function makeNoopService() {
    return new Proxy({}, {
        get: (_target, _prop) => vi.fn(),
    });
}

function makeRouterContext(overrides: Record<string, unknown> = {}) {
    const diagnosticsAggregator = {
        getSnapshot: vi.fn(() => ({
            inference: { selectedProviderId: null },
            mcp: { services: [] },
        })),
        getSystemHealthSnapshot: vi.fn(() => ({
            overall_status: 'healthy',
            trust_score: 1,
            effective_mode: 'NORMAL',
            mode_contract: {
                operator_actions_allowed: [],
            },
        })),
        getSystemModeSnapshot: vi.fn(() => ({
            effective_mode: 'NORMAL',
            active_degradation_flags: [],
            mode_contract: { mode: 'NORMAL' },
            recent_mode_transitions: [],
        })),
        setOperatorModeOverride: vi.fn(),
        getOperatorModeOverride: vi.fn(() => null),
    } as any;

    return {
        app: makeNoopService(),
        getMainWindow: () => null,
        agent: { ...makeNoopService(), setDiagnosticsAggregator: vi.fn(), setWorkspaceRoot: vi.fn() },
        fileService: { ...makeNoopService(), getRoot: vi.fn(() => null) },
        terminalService: { ...makeNoopService(), setRoot: vi.fn() },
        systemService: makeNoopService(),
        mcpService: makeNoopService(),
        functionService: makeNoopService(),
        workflowService: {
            ...makeNoopService(),
            listWorkflows: vi.fn(() => []),
            saveRun: vi.fn(),
        },
        workflowEngine: {
            ...makeNoopService(),
            setDebugCallback: vi.fn(),
            executeWorkflow: vi.fn(async () => ({ success: true, logs: [], context: {} })),
        },
        guardrailService: makeNoopService(),
        gitService: makeNoopService(),
        backupService: makeNoopService(),
        inferenceService: makeNoopService(),
        userProfileService: makeNoopService(),
        codeControlService: makeNoopService(),
        logViewerService: makeNoopService(),
        diagnosticsAggregator,
        runtimeControl: makeNoopService(),
        operatorActionService: {
            executeAction: vi.fn(async (request) => ({
                action_id: 'act-1',
                action: request.action,
                requested_by: request.requested_by,
                executed_at: '2026-04-14T12:00:00.000Z',
                allowed: true,
                reason: 'action_executed',
                affected_subsystems: ['diagnostics'],
                resulting_mode_change: null,
                resulting_health_delta: {
                    overall_before: 'healthy',
                    overall_after: 'healthy',
                    trust_score_before: 1,
                    trust_score_after: 1,
                    trust_score_delta: 0,
                    new_incidents: [],
                    resolved_incidents: [],
                },
                rollback_availability: 'none',
                source: 'operator',
            })),
            getActionHistory: vi.fn(() => []),
            getAutoRepairHistory: vi.fn(() => []),
            getVisibilityState: vi.fn(() => ({
                acknowledged_incidents: [],
                muted_duplicate_alert_keys: [],
                pinned_issue: null,
                self_improvement_locked: false,
                high_risk_human_approval_required: false,
            })),
            getAvailableActions: vi.fn(() => [
                {
                    action: 'retry_subsystem_health_check',
                    label: 'Retry Health Check',
                    category: 'recovery_control',
                    risk_level: 'low',
                    recommended: true,
                    allowed: true,
                    reason: 'available',
                    requires_explicit_approval: false,
                    affected_subsystems: ['diagnostics'],
                },
            ]),
        },
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
        ...overrides,
    } as any;
}

describe('IpcRouter operator governance handlers', () => {
    const handlers = new Map<string, (...args: any[]) => any>();

    beforeEach(() => {
        handlers.clear();
        (ipcMain as any).handle = vi.fn((channel: string, handler: (...args: any[]) => any) => {
            handlers.set(channel, handler);
        });
        (ipcMain as any).on = vi.fn();
        (ipcMain as any).removeHandler = vi.fn();
    });

    it('routes operator:executeAction through OperatorActionService over IPC', async () => {
        const ctx = makeRouterContext();
        const router = new IpcRouter(ctx);
        router.registerAll();

        const handler = handlers.get('operator:executeAction');
        expect(handler).toBeTruthy();
        const result = await handler?.({}, {
            action: 'retry_subsystem_health_check',
            requested_by: 'ipc_test',
        });

        expect(ctx.operatorActionService.executeAction).toHaveBeenCalled();
        expect(result.allowed).toBe(true);
        expect(result.action).toBe('retry_subsystem_health_check');
    });

    it('returns deterministic fallback contract when OperatorActionService is not initialized', async () => {
        const ctx = makeRouterContext({ operatorActionService: undefined });
        const router = new IpcRouter(ctx);
        router.registerAll();

        const handler = handlers.get('operator:executeAction');
        const result = await handler?.({}, {
            action: 'retry_subsystem_health_check',
            requested_by: 'ipc_test',
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('operator_action_service_not_initialized');
    });

    it('returns operator action availability via operator:getActionState IPC', async () => {
        const ctx = makeRouterContext();
        const router = new IpcRouter(ctx);
        router.registerAll();

        const handler = handlers.get('operator:getActionState');
        const state = await handler?.({});
        expect(state.available_actions.length).toBe(1);
        expect(state.available_actions[0].action).toBe('retry_subsystem_health_check');
    });

    it('enforces mode gating on execute-workflow IPC entrypoint', async () => {
        const deny = vi.spyOn(SystemModeManager, 'assertCapability')
            .mockImplementation(() => { throw new Error('Blocked by runtime mode SAFE_MODE'); });
        const ctx = makeRouterContext();
        const router = new IpcRouter(ctx);
        router.registerAll();

        const handler = handlers.get('execute-workflow');
        await expect(handler?.({}, { workflowId: 'wf-1', input: {} }))
            .rejects.toThrow(/Blocked by runtime mode SAFE_MODE/);
        expect(deny).toHaveBeenCalledWith('workflow_execute', 'IpcRouter.execute-workflow');
        deny.mockRestore();
    });
});
