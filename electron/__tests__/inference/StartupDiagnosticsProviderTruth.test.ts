import { describe, expect, it, vi } from 'vitest';
import { InferenceService } from '../../services/InferenceService';

describe('StartupDiagnosticsProviderTruth', () => {
  it('scanLocal reports only active local provider concepts (ollama/vllm)', async () => {
    const service = new InferenceService({
      ollama: { enabled: true, endpoint: 'http://127.0.0.1:11434' },
      embeddedVllm: { enabled: true, port: 8000, modelId: 'qwen2.5:3b' },
    });

    vi.spyOn(service as any, '_checkPort').mockImplementation(async (port: number) => port === 11434 || port === 1234);
    vi.spyOn(service as any, '_fetchOllamaModels').mockResolvedValue(['llama3:latest']);
    vi.spyOn(service as any, '_fetchOpenAIModels').mockResolvedValue(['qwen2.5:3b']);

    const providers = await service.scanLocal();
    const engines = providers.map((p) => p.engine);

    expect(engines).toEqual(['ollama', 'vllm']);
    expect(engines).not.toContain('llamacpp');
  });

  it('inventory refresh does not surface embedded_llamacpp as an active provider id', async () => {
    const service = new InferenceService({
      ollama: { enabled: true, endpoint: 'http://127.0.0.1:11434' },
      embeddedVllm: { enabled: true, port: 8000, modelId: 'qwen2.5:3b' },
      ...( { embeddedLlamaCpp: { enabled: true, port: 8080 } } as Record<string, unknown> ),
    } as any);

    const inventory = service.getProviderInventory();
    const ids = inventory.providers.map((p) => p.providerId);

    expect(ids).toContain('ollama');
    expect(ids).toContain('embedded_vllm');
    expect(ids).not.toContain('embedded_llamacpp');
  });
});
