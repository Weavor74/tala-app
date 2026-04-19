import { describe, expect, it } from 'vitest';
import { InferenceProviderRegistry } from '../../services/inference/InferenceProviderRegistry';
import { ProviderSelectionService } from '../../services/inference/ProviderSelectionService';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

describe('ProviderInventoryMigration', () => {
  it('does not expose embedded_llamacpp in active provider inventory', () => {
    const registry = new InferenceProviderRegistry({
      ollama: { enabled: true, endpoint: 'http://127.0.0.1:11434' },
      embeddedVllm: { enabled: true, port: 8000, modelId: 'qwen2.5:3b' },
      // legacy config key is ignored even if present in stale persisted settings
      ...( { embeddedLlamaCpp: { enabled: true, port: 8080 } } as Record<string, unknown> ),
    } as any);

    const providerIds = registry.getInventory().providers.map((p) => p.providerId);
    expect(providerIds).toContain('ollama');
    expect(providerIds).toContain('embedded_vllm');
    expect(providerIds).not.toContain('embedded_llamacpp');
  });

  it('uses fallback order without llama providers', () => {
    const registry = new InferenceProviderRegistry({});
    const descriptors = new Map<string, InferenceProviderDescriptor>();
    descriptors.set('ollama', {
      providerId: 'ollama',
      displayName: 'Ollama',
      providerType: 'ollama',
      scope: 'local',
      transport: 'http_ollama',
      endpoint: 'http://127.0.0.1:11434',
      configured: true,
      detected: true,
      ready: false,
      health: 'unavailable',
      status: 'not_running',
      priority: 10,
      capabilities: { streaming: true, toolCalls: true, vision: false, embeddings: false },
      models: [],
    });
    descriptors.set('embedded_vllm', {
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
      priority: 50,
      capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
      models: ['qwen2.5:3b'],
    });
    (registry as any).descriptors = descriptors;

    const selection = new ProviderSelectionService(registry).select({ mode: 'auto' });
    expect(selection.success).toBe(true);
    expect(selection.selectedProvider?.providerId).toBe('embedded_vllm');
    expect(selection.attemptedProviders).toContain('ollama');
    expect(selection.attemptedProviders).not.toContain('embedded_llamacpp');
    expect(selection.attemptedProviders).not.toContain('llamacpp');
  });
});
