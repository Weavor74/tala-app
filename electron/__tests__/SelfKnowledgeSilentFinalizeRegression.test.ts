import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../services/IpcRouter';

function makeNoopService() {
    return new Proxy({}, { get: () => vi.fn() });
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
        workflowEngine: { ...makeNoopService(), setDebugCallback: vi.fn(), executeWorkflow: vi.fn(async () => ({ success: true })) },
        guardrailService: makeNoopService(),
        gitService: makeNoopService(),
        backupService: makeNoopService(),
        inferenceService: makeNoopService(),
        userProfileService: makeNoopService(),
        codeControlService: makeNoopService(),
        logViewerService: makeNoopService(),
        diagnosticsAggregator: {
            getSnapshot: vi.fn(() => ({ inference: { selectedProviderId: null }, mcp: { services: [] } })),
            getSystemHealthSnapshot: vi.fn(() => ({ overall_status: 'healthy', trust_score: 1, effective_mode: 'NORMAL', mode_contract: { operator_actions_allowed: [] } })),
            getSystemModeSnapshot: vi.fn(() => ({ effective_mode: 'NORMAL', active_degradation_flags: [], mode_contract: { mode: 'NORMAL' }, recent_mode_transitions: [] })),
            setOperatorModeOverride: vi.fn(),
            getOperatorModeOverride: vi.fn(() => null),
        },
        runtimeControl: makeNoopService(),
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

describe('SelfKnowledgeSilentFinalizeRegression', () => {
    const onHandlers = new Map<string, (...args: any[]) => any>();
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tala-self-knowledge-regression-')), 'settings.json');
        onHandlers.clear();
        (ipcMain as any).handle = vi.fn();
        (ipcMain as any).on = vi.fn((channel: string, handler: (...args: any[]) => any) => onHandlers.set(channel, handler));
        (ipcMain as any).removeHandler = vi.fn();
    });

    it('never accepts chat-message completion without a visible reply', async () => {
        const router = new IpcRouter(makeRouterContext(settingsPath));
        router.registerAll();
        (router as any)._kernel = {
            execute: vi.fn(async () => ({
                message: 'Self-knowledge response from kernel.',
                outputChannel: 'chat',
                turnResult: {
                    kind: 'assistant_response',
                    source: 'self_knowledge',
                    message: {
                        content: 'Self-knowledge response from kernel.',
                        outputChannel: 'chat',
                    },
                },
                meta: {
                    executionId: 'exec-regression',
                    origin: 'ipc',
                    durationMs: 7,
                    routingDecision: { classification: 'trivial_direct_allowed' },
                    turnArbitration: { turnId: 'turn-regression', mode: 'conversational' },
                },
            })),
        };

        const chatHandler = onHandlers.get('chat-message');
        expect(chatHandler).toBeTruthy();

        const sender = { send: vi.fn() };
        await chatHandler?.({ sender }, { text: 'Hey tala what can you do?', images: [] });

        const sentChannels = sender.send.mock.calls.map((call: any[]) => call[0]);
        expect(sentChannels).toContain('chat-token');
        expect(sentChannels).toContain('chat-done');
        const tokenIndex = sentChannels.indexOf('chat-token');
        const doneIndex = sentChannels.indexOf('chat-done');
        expect(tokenIndex).toBeGreaterThanOrEqual(0);
        expect(doneIndex).toBeGreaterThanOrEqual(tokenIndex);
    });
});

