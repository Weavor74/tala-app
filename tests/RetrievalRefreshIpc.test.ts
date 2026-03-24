/**
 * RetrievalRefreshIpc.test.ts
 *
 * Regression coverage for the retrieval:refreshExternalProvider IPC handler.
 *
 * This handler is one of the known Phase 1 runtime repairs:
 *   - It must have exactly one IPC registration (enforced by IpcChannelUniqueness.test.ts).
 *   - It must return { success: true } on normal completion.
 *   - It must return { success: false, error: message } on failure, never throw.
 *   - It must degrade gracefully when no external providers are configured
 *     (local-first invariant).
 *
 * We test the handler logic in isolation by exercising refreshExternalProvider()
 * and loadSettings() via mocks, mirroring exactly what IpcRouter does at line
 * ~1899 of IpcRouter.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
    ipcMain: { handle: vi.fn() },
}));

const mockLoadSettings = vi.fn();
const mockRefreshExternalProvider = vi.fn();

vi.mock('../electron/services/SettingsManager', () => ({
    loadSettings: (...args: any[]) => mockLoadSettings(...args),
    saveSettings: vi.fn(),
    DEFAULT_SETTINGS: {},
    getActiveMode: vi.fn(),
    setActiveMode: vi.fn(),
    normalizeProviderEntry: vi.fn((p: any) => p),
}));

vi.mock('../electron/services/retrieval/RetrievalOrchestratorRegistry', () => ({
    refreshExternalProvider: (...args: any[]) => mockRefreshExternalProvider(...args),
    getRetrievalOrchestrator: vi.fn(() => null),
    initRetrievalOrchestrator: vi.fn(),
}));

// ─── Handler under test ───────────────────────────────────────────────────────

/**
 * Mirrors the exact logic of the retrieval:refreshExternalProvider handler
 * in IpcRouter.ts (~line 1899), extracted here so we can test it in isolation.
 */
async function handleRefreshExternalProvider(
    loadSettingsFn: (p: string) => Record<string, any>,
    refreshFn: (search: any) => void,
    settingsPath: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const s = loadSettingsFn(settingsPath);
        refreshFn(s.search);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('retrieval:refreshExternalProvider IPC handler', () => {
    const SETTINGS_PATH = '/tmp/test-settings.json';

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns { success: true } when loadSettings and refreshExternalProvider both succeed', async () => {
        mockLoadSettings.mockReturnValue({ search: { activeProviderId: 'brave', providers: [] } });
        mockRefreshExternalProvider.mockReturnValue(undefined);

        const result = await handleRefreshExternalProvider(
            mockLoadSettings,
            mockRefreshExternalProvider,
            SETTINGS_PATH,
        );

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it('calls refreshExternalProvider with the search config from loaded settings', async () => {
        const searchConfig = { activeProviderId: 'brave', providers: [{ id: 'brave', type: 'brave', enabled: true }] };
        mockLoadSettings.mockReturnValue({ search: searchConfig });
        mockRefreshExternalProvider.mockReturnValue(undefined);

        await handleRefreshExternalProvider(
            mockLoadSettings,
            mockRefreshExternalProvider,
            SETTINGS_PATH,
        );

        expect(mockRefreshExternalProvider).toHaveBeenCalledWith(searchConfig);
    });

    it('returns { success: false, error } when refreshExternalProvider throws', async () => {
        mockLoadSettings.mockReturnValue({ search: {} });
        mockRefreshExternalProvider.mockImplementation(() => {
            throw new Error('Registry not initialized');
        });

        const result = await handleRefreshExternalProvider(
            mockLoadSettings,
            mockRefreshExternalProvider,
            SETTINGS_PATH,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Registry not initialized');
    });

    it('returns { success: false, error } when loadSettings throws', async () => {
        mockLoadSettings.mockImplementation(() => {
            throw new Error('Settings file corrupted');
        });

        const result = await handleRefreshExternalProvider(
            mockLoadSettings,
            mockRefreshExternalProvider,
            SETTINGS_PATH,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Settings file corrupted');
        expect(mockRefreshExternalProvider).not.toHaveBeenCalled();
    });

    it('returns { success: true } when settings have no external providers (local-first degradation)', async () => {
        // Settings file exists but has no search config — pure local-first setup
        mockLoadSettings.mockReturnValue({ search: undefined });
        mockRefreshExternalProvider.mockReturnValue(undefined);

        const result = await handleRefreshExternalProvider(
            mockLoadSettings,
            mockRefreshExternalProvider,
            SETTINGS_PATH,
        );

        expect(result.success).toBe(true);
        // refreshExternalProvider is still called with undefined search — it handles this gracefully
        expect(mockRefreshExternalProvider).toHaveBeenCalledWith(undefined);
    });

    it('does not throw — always returns a structured object', async () => {
        mockLoadSettings.mockImplementation(() => { throw new Error('Fatal disk error'); });

        let threw = false;
        let result: any;
        try {
            result = await handleRefreshExternalProvider(
                mockLoadSettings,
                mockRefreshExternalProvider,
                SETTINGS_PATH,
            );
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');
    });
});
