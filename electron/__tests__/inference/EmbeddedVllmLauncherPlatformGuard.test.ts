import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('EmbeddedVllmLauncherPlatformGuard', () => {
    it('uses explicit Windows platform guard with no direct uvloop dependency', () => {
        const entryPath = path.join(process.cwd(), 'scripts', 'vllm-server-entry.py');
        const source = fs.readFileSync(entryPath, 'utf-8');

        expect(source).toContain('is_windows = platform.system().lower().startswith("win")');
        expect(source).toContain('uvloop is not required');
        expect(source).not.toMatch(/^import uvloop$/m);
    });

    it('retains non-Windows module launch behavior via subprocess', () => {
        const entryPath = path.join(process.cwd(), 'scripts', 'vllm-server-entry.py');
        const source = fs.readFileSync(entryPath, 'utf-8');

        expect(source).toContain('"-m", "vllm.entrypoints.openai.api_server"');
        expect(source).toContain('subprocess.call(launch_command)');
    });
});
