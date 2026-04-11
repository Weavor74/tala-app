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
        expect(Array.isArray(bundle.issueClusters)).toBe(true);
    });

    it('clusters repeated file-not-found events into one key and escalates severity', async () => {
        const repeated = Array.from({ length: 8 }, (_, i) =>
            `[Error] Error occurred in handler for 'read-file': Error: File not found at C:\\temp\\run-${i}.txt`
        ).join('\n');
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${repeated}\n`, 'utf-8');

        const bundle = await service.buildIssueEvidenceBundle();
        const cluster = bundle.issueClusters.find((c: any) => c.family === 'ipc.read-file.file_not_found');

        expect(cluster).toBeTruthy();
        expect(cluster.eventCount).toBe(8);
        expect(cluster.computedSeverity === 'medium' || cluster.computedSeverity === 'high' || cluster.computedSeverity === 'critical').toBe(true);
        expect(cluster.escalationReasons).toContain('repeated_occurrence');
    });

    it('normalizes volatile identifiers so similar lines cluster together', async () => {
        const lineA = `[Runtime] Error occurred in handler for 'read-file': Error: File not found id=123e4567-e89b-12d3-a456-426614174000 path=C:\\temp\\a.txt`;
        const lineB = `[Runtime] Error occurred in handler for 'read-file': Error: File not found id=888e4567-e89b-12d3-a456-426614174999 path=C:\\temp\\b.txt`;
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${lineA}\n${lineB}\n`, 'utf-8');

        const bundle = await service.buildIssueEvidenceBundle();
        const cluster = bundle.issueClusters.find((c: any) => c.family === 'ipc.read-file.file_not_found');
        expect(cluster.eventCount).toBe(2);
    });

    it('keeps distinct issue families separate', async () => {
        const lines = [
            `[Error] Error occurred in handler for 'read-file': Error: File not found`,
            `[Provider] provider unreachable: ollama`,
            `[Prompt] prompt overflow: too long`,
        ].join('\n');
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${lines}\n`, 'utf-8');

        const bundle = await service.buildIssueEvidenceBundle();
        const families = new Set(bundle.issueClusters.map((c: any) => c.family));
        expect(families.has('ipc.read-file.file_not_found')).toBe(true);
        expect(Array.from(families).some((f: any) => String(f).startsWith('provider.discovery.unreachable'))).toBe(true);
        expect(families.has('prompt.overflow')).toBe(true);
    });

    it('stores bounded representative samples per cluster', async () => {
        const repeated = Array.from({ length: 40 }, (_, i) =>
            `[Error] Error occurred in handler for 'read-file': Error: File not found at C:\\temp\\${i}.txt`
        ).join('\n');
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${repeated}\n`, 'utf-8');

        const bundle = await service.buildIssueEvidenceBundle();
        const cluster = bundle.issueClusters.find((c: any) => c.family === 'ipc.read-file.file_not_found');
        expect(cluster.representativeSamples.length).toBeLessThanOrEqual(5);
    });

    it('handles malformed lines without breaking clustering', async () => {
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `\n\nnot-json\n{bad json\n`, 'utf-8');
        const bundle = await service.buildIssueEvidenceBundle();
        expect(Array.isArray(bundle.issueClusters)).toBe(true);
    });

    it('uses persisted cluster history for consecutive-run escalation', async () => {
        const single = `[Error] Error occurred in handler for 'read-file': Error: File not found`;
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${single}\n`, 'utf-8');

        const first = await service.buildIssueEvidenceBundle();
        service.recordIssueClusters(first.issueClusters);
        const second = await service.buildIssueEvidenceBundle();
        const cluster = second.issueClusters.find((c: any) => c.family === 'ipc.read-file.file_not_found');
        expect(cluster.priorRunCount).toBeGreaterThanOrEqual(1);
    });
});
