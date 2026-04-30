import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'fs';
import { checkEmbeddedVllmAvailability, InferenceProviderRegistry } from '../electron/services/inference/InferenceProviderRegistry';
import { ProviderSelectionService } from '../electron/services/inference/ProviderSelectionService';

describe('InferenceWindowsPreflight', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('marks embedded_vllm unavailable on win32 when uvloop is required but missing', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
            const path = String(p).replace(/\\/g, '/');
            if (path.endsWith('/api_server.py')) return true;
            if (path.endsWith('/site-packages/uvloop')) return false;
            return false;
        });
        vi.spyOn(fs, 'readFileSync').mockReturnValue('import uvloop\n' as any);

        const result = await checkEmbeddedVllmAvailability(8000, 'test-model');
        expect(result.reachable).toBe(false);
        expect(result.reasonCode).toBe('embedded_vllm_unavailable_windows_uvloop');
    });

    it('selects ollama when embedded_vllm is unavailable', () => {
        const registry = new InferenceProviderRegistry({
            ollama: { enabled: true },
            embeddedVllm: { enabled: true, modelId: 'test-model' },
        });

        const inventory = registry.getInventory();
        const ollama = inventory.providers.find((p) => p.providerId === 'ollama')!;
        const embedded = inventory.providers.find((p) => p.providerId === 'embedded_vllm')!;
        ollama.ready = true;
        ollama.status = 'ready';
        embedded.ready = false;
        embedded.status = 'unavailable';

        const selection = new ProviderSelectionService(registry).select({ mode: 'local-only' });
        expect(selection.success).toBe(true);
        expect(selection.selectedProvider?.providerId).toBe('ollama');
    });
});

