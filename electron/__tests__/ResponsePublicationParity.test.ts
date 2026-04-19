import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../services/IpcRouter';
import { TelemetryBus } from '../services/telemetry/TelemetryBus';

function makeNoopService() {
    return new Proxy({}, {
        get: () => vi.fn(),
    });
}

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-response-publication-parity-'));
    return path.join(dir, 'app_settings.json');
}

function makeRouterContext(settingsPath: string) {
    return {
        app: makeNoopService(),
        getMainWindow: () => null,
        agent: { ...makeNoopService(), setDiagnosticsAggregator: vi.fn(), setWorkspaceRoot: vi.fn() },
        fileService: { ...makeNoopService(), getRoot: vi.fn(() => null) },
        terminalService: { ...makeNoopService(), setRoot: vi.fn() },
        systemService: makeNoopService(),
        mcpService: makeNoopService(),
        functionService: makeNoopService(),
        workflowService: makeNoopService(),
        workflowEngine: {
            ...makeNoopService(),
            setDebugCallback: vi.fn(),
            executeWorkflow: vi.fn(async () => ({ success: true })),
        },
        guardrailService: makeNoopService(),
        gitService: makeNoopService(),
        backupService: makeNoopService(),
        inferenceService: makeNoopService(),
        userProfileService: makeNoopService(),
        codeControlService: makeNoopService(),
        logViewerService: makeNoopService(),
        diagnosticsAggregator: {
            getSnapshot: vi.fn(() => ({
                inference: { selectedProviderId: null },
                mcp: { services: [] },
            })),
            getSystemHealthSnapshot: vi.fn(() => ({
                overall_status: 'healthy',
                trust_score: 1,
                effective_mode: 'NORMAL',
                mode_contract: { operator_actions_allowed: [] },
            })),
            getSystemModeSnapshot: vi.fn(() => ({
                effective_mode: 'NORMAL',
                active_degradation_flags: [],
                mode_contract: { mode: 'NORMAL' },
                recent_mode_transitions: [],
            })),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
        },
        runtimeControl: makeNoopService(),
        operatorActionService: undefined,
        worldModelAssembler: undefined,
        maintenanceLoopService: undefined,
        getSettingsPath: () => settingsPath,
        setSettingsPath: vi.fn(),
        USER_DATA_DIR: path.dirname(settingsPath),
        USER_DATA_PATH: settingsPath,
        APP_DIR: path.dirname(settingsPath),
        PORTABLE_SETTINGS_PATH: settingsPath,
        SYSTEM_SETTINGS_PATH: settingsPath,
        TEMP_SYSTEM_PATH: path.dirname(settingsPath),
    } as any;
}

describe('ResponsePublicationParity', () => {
    const onHandlers = new Map<string, (...args: any[]) => any>();
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        TelemetryBus._resetForTesting();
        onHandlers.clear();
        (ipcMain as any).handle = vi.fn();
        (ipcMain as any).on = vi.fn((channel: string, handler: (...args: any[]) => any) => {
            onHandlers.set(channel, handler);
        });
        (ipcMain as any).removeHandler = vi.fn();
    });

    it('publishes self-knowledge responses through the same chat-token/chat-done seam', async () => {
        const router = new IpcRouter(makeRouterContext(settingsPath));
        router.registerAll();
        (router as any)._kernel = {
            execute: vi.fn(async () => ({
                message: 'I can inspect my capabilities and route deterministic tasks.',
                outputChannel: 'chat',
                turnResult: {
                    kind: 'assistant_response',
                    source: 'self_knowledge',
                    message: {
                        content: 'I can inspect my capabilities and route deterministic tasks.',
                        outputChannel: 'chat',
                    },
                },
                meta: {
                    executionId: 'exec-self-knowledge',
                    durationMs: 12,
                    routingDecision: { classification: 'trivial_direct_allowed' },
                    turnArbitration: { turnId: 'turn-self-knowledge', mode: 'conversational' },
                    origin: 'ipc',
                },
            })),
        };

        const chatHandler = onHandlers.get('chat-message');
        expect(chatHandler).toBeTruthy();

        const sender = { send: vi.fn() };
        await chatHandler?.({ sender }, { text: 'What can you do?', images: [] });

        expect(sender.send).toHaveBeenCalledWith('chat-token', 'I can inspect my capabilities and route deterministic tasks.');
        expect(sender.send).toHaveBeenCalledWith(
            'chat-done',
            expect.objectContaining({
                message: 'I can inspect my capabilities and route deterministic tasks.',
                executionId: 'exec-self-knowledge',
            }),
        );
    });
});

