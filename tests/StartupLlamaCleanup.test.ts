import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('StartupLlamaCleanup', () => {
    it('launch-inference script no longer runs llama-era conflict logic', () => {
        const launcherPath = path.join(process.cwd(), 'scripts', 'diagnostics', 'launch-inference.bat');
        const source = fs.readFileSync(launcherPath, 'utf-8');

        expect(source).not.toContain('Skipping local llama_cpp instance');
        expect(source).not.toContain('llama_cpp');
        expect(source).not.toContain('llama_cpp.server');
        expect(source).toContain('embedded_vllm');
    });

    it('InferenceService startup does not eagerly construct legacy LocalEngineService', async () => {
        vi.resetModules();
        let constructed = 0;

        vi.doMock('../electron/services/LocalEngineService', () => ({
            LocalEngineService: class {
                constructor() {
                    constructed++;
                }
            },
        }));

        const { InferenceService } = await import('../electron/services/InferenceService');
        const svc = new InferenceService();

        expect(svc).toBeTruthy();
        expect(constructed).toBe(0);
    });
});
