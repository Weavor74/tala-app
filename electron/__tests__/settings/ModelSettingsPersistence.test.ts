import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../../services/IpcRouter';
import { loadSettings } from '../../services/SettingsManager';

function makeNoopService() {
  return new Proxy({}, { get: () => vi.fn() });
}

function makeSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-settings-persist-'));
  return path.join(dir, 'app_settings.json');
}

function makeContext(settingsPath: string) {
  return {
    app: makeNoopService(),
    getMainWindow: () => null,
    agent: { ...makeNoopService(), setDiagnosticsAggregator: vi.fn(), setWorkspaceRoot: vi.fn(), refreshMcpTools: vi.fn(), reloadConfig: vi.fn() },
    fileService: { ...makeNoopService(), getRoot: vi.fn(() => null) },
    terminalService: { ...makeNoopService(), setRoot: vi.fn(), setCustomEnv: vi.fn() },
    systemService: makeNoopService(),
    mcpService: { ...makeNoopService(), sync: vi.fn(async () => true) },
    mcpAuthority: {
      syncConfiguredServers: vi.fn(() => [{ serverId: 'filesystem', ok: false, reasonCode: 'unknown' }]),
      activateAllConfiguredServers: vi.fn(async () => undefined),
    },
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

describe('ModelSettingsPersistence', () => {
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

  it('persists model/provider settings even when filesystem MCP registration is rejected', async () => {
    const router = new IpcRouter(makeContext(settingsPath));
    router.registerAll();

    const saveSettingsHandler = handlers.get('save-settings') as ((e: any, data: any) => Promise<any>);
    const result = await saveSettingsHandler({}, {
      inference: {
        mode: 'local-only',
        activeLocalId: 'local-vllm',
        instances: [
          { id: 'local-ollama', alias: 'Ollama', source: 'local', engine: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3', priority: 1 },
          { id: 'local-vllm', alias: 'Embedded vLLM', source: 'local', engine: 'vllm', endpoint: 'http://127.0.0.1:8000', model: 'qwen2.5:3b', priority: 2 },
        ],
      },
      mcpServers: [{ id: 'filesystem', name: 'filesystem', type: 'stdio', enabled: true }],
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.join(' ')).toContain('MCP registration rejected (filesystem)');

    const saved = loadSettings(settingsPath);
    expect(saved.inference.activeLocalId).toBe('local-vllm');
    expect(saved.inference.instances.find((i: any) => i.id === 'local-vllm')?.model).toBe('qwen2.5:3b');
  });
});
