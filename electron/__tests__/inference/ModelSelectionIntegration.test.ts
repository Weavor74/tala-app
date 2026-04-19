import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcRouter } from '../../services/IpcRouter';

function makeNoopService() {
  return new Proxy({}, { get: () => vi.fn() });
}

function makeSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-model-selection-'));
  return path.join(dir, 'app_settings.json');
}

function makeContext(settingsPath: string) {
  const providers = {
    providers: [
      {
        providerId: 'ollama',
        displayName: 'Ollama',
        providerType: 'ollama',
        scope: 'local',
        transport: 'http_ollama',
        endpoint: 'http://127.0.0.1:11434',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 10,
        capabilities: { streaming: true, toolCalls: true, vision: false, embeddings: false },
        models: ['llama3:latest'],
      },
      {
        providerId: 'embedded_vllm',
        displayName: 'Embedded vLLM',
        providerType: 'embedded_vllm',
        scope: 'embedded',
        transport: 'http_openai_compat',
        endpoint: 'http://127.0.0.1:8000',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 20,
        capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
        models: ['qwen2.5:3b'],
      },
    ],
    selectedProviderId: 'ollama',
    lastRefreshed: new Date().toISOString(),
    refreshing: false,
  };

  const inferenceService = {
    refreshProviders: vi.fn(async () => providers),
    getProviderInventory: vi.fn(() => providers),
    setSelectedProvider: vi.fn((id?: string) => {
      providers.selectedProviderId = id;
    }),
  };

  return {
    app: makeNoopService(),
    getMainWindow: () => null,
    agent: { ...makeNoopService(), setDiagnosticsAggregator: vi.fn(), setWorkspaceRoot: vi.fn(), reloadConfig: vi.fn(), refreshMcpTools: vi.fn() },
    fileService: { ...makeNoopService(), getRoot: vi.fn(() => null) },
    terminalService: { ...makeNoopService(), setRoot: vi.fn(), setCustomEnv: vi.fn() },
    systemService: makeNoopService(),
    mcpService: makeNoopService(),
    mcpAuthority: undefined,
    functionService: makeNoopService(),
    workflowService: makeNoopService(),
    workflowEngine: { ...makeNoopService(), setDebugCallback: vi.fn(), executeWorkflow: vi.fn(async () => ({ success: true })) },
    guardrailService: makeNoopService(),
    gitService: makeNoopService(),
    backupService: makeNoopService(),
    inferenceService,
    userProfileService: makeNoopService(),
    codeControlService: makeNoopService(),
    logViewerService: makeNoopService(),
    diagnosticsAggregator: {
      getSnapshot: vi.fn(() => ({ inference: { selectedProviderId: providers.selectedProviderId }, mcp: { services: [] } })),
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

describe('ModelSelectionIntegration', () => {
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

  it('exposes ollama + embedded_vllm through selector IPC and excludes stale llama provider ids', async () => {
    const router = new IpcRouter(makeContext(settingsPath));
    router.registerAll();

    const scan = handlers.get('scan-local-providers') as ((e: any) => Promise<any[]>);
    const providers = await scan({});

    const engines = providers.map((p) => p.engine);
    expect(engines).toContain('ollama');
    expect(engines).toContain('embedded_vllm');
    expect(engines).not.toContain('embedded_llamacpp');
    expect(engines).not.toContain('llamacpp');
  });

  it('updates selected provider through inference selection IPC', async () => {
    const ctx = makeContext(settingsPath);
    const router = new IpcRouter(ctx);
    router.registerAll();

    const select = handlers.get('inference:selectProvider') as ((e: any, id?: string) => Promise<any>);
    const getSelected = handlers.get('inference:getSelectedProvider') as ((e: any) => Promise<any>);

    await select({}, 'embedded_vllm');
    const selected = await getSelected({});

    expect(selected?.providerId).toBe('embedded_vllm');
    expect(ctx.inferenceService.setSelectedProvider).toHaveBeenCalledWith('embedded_vllm');
  });
});
