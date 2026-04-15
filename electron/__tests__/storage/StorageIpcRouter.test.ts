import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../../services/IpcRouter';
import type {
    StorageAddProviderRequest,
    StorageAddProviderResponse,
    StorageAssignRoleRequest,
    StorageAssignRoleResponse,
    StorageRemoveProviderRequest,
    StorageRemoveProviderResponse,
    StorageSetProviderEnabledRequest,
    StorageSetProviderEnabledResponse,
} from '../../services/storage/storageTypes';
import {
    StorageHealthStatus,
    StorageLocality,
    StorageOperationErrorCode,
    StorageProviderKind,
    StorageRegistrationMode,
    StorageRole,
} from '../../services/storage/storageTypes';

function makeNoopService() {
    return new Proxy({}, {
        get: () => vi.fn(),
    });
}

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-ipc-'));
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

describe('Storage IPC routes', () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        handlers.clear();
        (ipcMain as any).handle = vi.fn((channel: string, handler: (...args: any[]) => any) => {
            handlers.set(channel, handler);
        });
        (ipcMain as any).on = vi.fn();
        (ipcMain as any).removeHandler = vi.fn();
    });

    it('canonical invalid assignment through IPC is blocked', async () => {
        const router = new IpcRouter(makeRouterContext(settingsPath));
        router.registerAll();

        const add = handlers.get('storage:addProvider') as ((e: any, request: StorageAddProviderRequest) => Promise<StorageAddProviderResponse>);
        const assign = handlers.get('storage:assignRole') as ((e: any, request: StorageAssignRoleRequest) => Promise<StorageAssignRoleResponse>);

        const addReq: StorageAddProviderRequest = {
            id: 's3:test',
            name: 'S3 Test',
            kind: StorageProviderKind.S3,
            locality: StorageLocality.REMOTE,
            registrationMode: StorageRegistrationMode.MANUAL,
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
        };
        const addResult: StorageAddProviderResponse = await add({}, addReq);
        expect(addResult.ok).toBe(true);

        const assignResult: StorageAssignRoleResponse = await assign({}, {
            providerId: 's3:test',
            role: StorageRole.CANONICAL_MEMORY,
        });
        expect(assignResult.ok).toBe(false);
        if (!assignResult.ok) {
            expect(assignResult.error.code).toBe(StorageOperationErrorCode.CANONICAL_ROLE_RESTRICTED);
        }
    });

    it('removal and disable of sole canonical provider through IPC are blocked', async () => {
        const router = new IpcRouter(makeRouterContext(settingsPath));
        router.registerAll();

        const add = handlers.get('storage:addProvider') as ((e: any, request: StorageAddProviderRequest) => Promise<StorageAddProviderResponse>);
        const assign = handlers.get('storage:assignRole') as ((e: any, request: StorageAssignRoleRequest) => Promise<StorageAssignRoleResponse>);
        const disable = handlers.get('storage:setProviderEnabled') as ((e: any, request: StorageSetProviderEnabledRequest) => Promise<StorageSetProviderEnabledResponse>);
        const remove = handlers.get('storage:removeProvider') as ((e: any, request: StorageRemoveProviderRequest) => Promise<StorageRemoveProviderResponse>);

        await add({}, {
            id: 'sqlite:canonical',
            name: 'SQLite Canonical',
            kind: StorageProviderKind.SQLITE,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
        });
        await assign({}, { providerId: 'sqlite:canonical', role: StorageRole.CANONICAL_MEMORY });

        const disableResult: StorageSetProviderEnabledResponse = await disable({}, {
            providerId: 'sqlite:canonical',
            enabled: false,
        });
        expect(disableResult.ok).toBe(false);
        if (!disableResult.ok) {
            expect(disableResult.error.code).toBe(StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED);
        }

        const removeResult: StorageRemoveProviderResponse = await remove({}, {
            providerId: 'sqlite:canonical',
        });
        expect(removeResult.ok).toBe(false);
        if (!removeResult.ok) {
            expect(removeResult.error.code).toBe(StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED);
        }
    });
});
