import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogInspectionService } from '../../services/reflection/LogInspectionService';

describe('Reflection LogInspectionService bounded reads', () => {
    let rootDir: string;
    let logsDir: string;
    let service: LogInspectionService;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-log-inspect-'));
        logsDir = path.join(rootDir, 'data', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        service = new LogInspectionService(rootDir);
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('uses bounded tail window and does not read full file via fs.promises.readFile', async () => {
        const runtimeLog = path.join(logsDir, 'runtime-errors.jsonl');
        const payload = Array.from({ length: 30000 }, (_, i) => `{"idx":${i},"level":"error"}`).join('\n');
        fs.writeFileSync(runtimeLog, `${payload}\n`, 'utf-8');
        const readFileSpy = vi.spyOn(fs.promises, 'readFile');

        const lines = await service.readRecentLogWindow('runtime-errors.jsonl', 120);

        expect(lines.length).toBeLessThanOrEqual(120);
        expect(lines.length).toBeGreaterThan(0);
        expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('returns empty result for missing source without crashing', async () => {
        const lines = await service.readRecentLogWindow('missing.jsonl', 50);
        expect(lines).toEqual([]);
    });

    it('builds evidence bundle from bounded recent log windows', async () => {
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), '{"err":"e1"}\n{"err":"e2"}\n', 'utf-8');
        fs.writeFileSync(path.join(logsDir, 'audit-log.jsonl'), '{"event":"a1"}\n', 'utf-8');
        fs.writeFileSync(path.join(logsDir, 'prompt-audit.jsonl'), '{"event":"p1"}\n', 'utf-8');

        const bundle = await service.buildIssueEvidenceBundle();

        expect(bundle.errors.length).toBeGreaterThan(0);
        expect(bundle.recentAudits.length).toBeGreaterThan(0);
        expect(bundle.recentPromptAudits.length).toBeGreaterThan(0);
    });
});
