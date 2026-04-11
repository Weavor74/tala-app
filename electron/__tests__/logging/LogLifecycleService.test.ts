import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLifecycleService } from '../../services/LogLifecycleService';

describe('LogLifecycleService', () => {
    let tempDir: string;
    let lifecycle: LogLifecycleService;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-log-life-'));
        lifecycle = new LogLifecycleService(tempDir, {
            maxActiveFileBytes: 80,
            rotatedRetentionCount: 2,
            recentReadMaxBytes: 1024,
            recentReadMaxLines: 100,
        });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('rotates when active log exceeds threshold and preserves active file', () => {
        const first = lifecycle.appendLine('runtime-errors.jsonl', `${'A'.repeat(60)}\n`);
        const second = lifecycle.appendLine('runtime-errors.jsonl', `${'B'.repeat(60)}\n`);

        expect(first.success).toBe(true);
        expect(second.rotated).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'runtime-errors.1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'runtime-errors.jsonl'))).toBe(true);
        expect(fs.statSync(path.join(tempDir, 'runtime-errors.jsonl')).size).toBe(0);
    });

    it('prunes old rotated logs beyond retention count with deterministic ordering', () => {
        const activePath = path.join(tempDir, 'runtime-errors.jsonl');
        const firstRotated = path.join(tempDir, 'runtime-errors.1.jsonl');
        const secondRotated = path.join(tempDir, 'runtime-errors.2.jsonl');
        fs.writeFileSync(activePath, `${'X'.repeat(200)}\n`, 'utf-8');
        fs.writeFileSync(firstRotated, 'old-1\n', 'utf-8');
        fs.writeFileSync(secondRotated, 'old-2\n', 'utf-8');

        lifecycle.rotateOversizedOnStartup('runtime-errors.jsonl');

        expect(fs.existsSync(path.join(tempDir, 'runtime-errors.1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'runtime-errors.2.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'runtime-errors.3.jsonl'))).toBe(false);
        expect(fs.readFileSync(path.join(tempDir, 'runtime-errors.2.jsonl'), 'utf-8')).toContain('old-1');
    });

    it('reads recent log window without whole-file reads and bounds returned lines', () => {
        const file = path.join(tempDir, 'runtime-errors.jsonl');
        const lines = Array.from({ length: 5000 }, (_, i) => `{"idx":${i},"msg":"line-${i}"}`).join('\n');
        fs.writeFileSync(file, `${lines}\n`, 'utf-8');
        const readFileSpy = vi.spyOn(fs.promises, 'readFile');

        const window = lifecycle.readRecentWindow('runtime-errors.jsonl', { maxBytes: 4096, maxLines: 25 });

        expect(window.skippedMissing).toBe(false);
        expect(window.lines.length).toBeLessThanOrEqual(25);
        expect(window.totalBytes).toBeGreaterThan(window.bytesRead);
        expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('discards incomplete first partial line in a tail slice', () => {
        const file = path.join(tempDir, 'runtime-errors.jsonl');
        const content = [
            'LONG-LINE-WILL-BE-CUT-AT-HEAD',
            '{"line":"FULL-1"}',
            '{"line":"FULL-2"}',
        ].join('\n');
        fs.writeFileSync(file, content, 'utf-8');

        const window = lifecycle.readRecentWindow('runtime-errors.jsonl', { maxBytes: 20 });

        expect(window.lines.length).toBeGreaterThan(0);
        expect(window.lines[0].startsWith('{"line":"')).toBe(true);
    });

    it('handles missing and empty files without crashing', () => {
        const missing = lifecycle.readRecentWindow('does-not-exist.jsonl');
        expect(missing.skippedMissing).toBe(true);
        expect(missing.lines).toEqual([]);

        fs.writeFileSync(path.join(tempDir, 'runtime-errors.jsonl'), '', 'utf-8');
        const empty = lifecycle.readRecentWindow('runtime-errors.jsonl');
        expect(empty.lines).toEqual([]);
        expect(empty.skippedMissing).toBe(false);
    });
});
