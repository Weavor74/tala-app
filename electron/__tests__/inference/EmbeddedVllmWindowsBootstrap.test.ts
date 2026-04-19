import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('EmbeddedVllmWindowsBootstrap', () => {
    it('Windows bootstrap path does not install uvloop directly', () => {
        const bootstrapPath = path.join(process.cwd(), 'scripts', 'bootstrap-vllm.ps1');
        const source = fs.readFileSync(bootstrapPath, 'utf-8');

        expect(source).not.toMatch(/pip install\s+uvloop/i);
        expect(source).toContain('uvloop-free Tala path');
    });

    it('Windows launcher uses Tala-managed wrapper instead of direct vLLM module startup', () => {
        const launcherPath = path.join(process.cwd(), 'scripts', 'run-vllm.bat');
        const source = fs.readFileSync(launcherPath, 'utf-8');

        expect(source).toContain('scripts\\vllm-server-entry.py');
        expect(source).not.toContain('-m vllm.entrypoints.openai.api_server');
    });
});
