import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReflectionService } from '../../services/reflection/ReflectionService';

describe('Reflection manual runtime evidence wiring', () => {
    let tmpDir: string;
    let service: ReflectionService;
    let settingsPath: string;
    let logsDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-reflection-manual-evidence-'));
        settingsPath = path.join(tmpDir, 'settings.json');
        logsDir = path.join(tmpDir, 'data', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify({ reflection: { enabled: true } }), 'utf-8');
        service = new ReflectionService(tmpDir, settingsPath, tmpDir);

        // Keep reflection stage deterministic for this wiring test.
        (service as any).reflection.analyzeIssue = vi.fn().mockResolvedValue({
            selectedHypothesis: 'clustered runtime evidence observed',
            confidence: 0.91,
            rejectedHypotheses: [],
        });
    });

    afterEach(() => {
        service.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('manual run consumes clustered runtime-errors evidence and progresses beyond no_runnable_items', async () => {
        const repeated = Array.from({ length: 8 }, (_, i) =>
            `[Error] Error occurred in handler for 'read-file': Error: File not found at C:\\missing\\file-${i}.txt`
        ).join('\n');
        fs.writeFileSync(path.join(logsDir, 'runtime-errors.jsonl'), `${repeated}\n`, 'utf-8');

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const schedulerTickSpy = vi.spyOn((service as any).scheduler, 'tickNow');
        const result = await (service as any).runManualReflectionNow('engineering', 'manual');
        const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');

        expect(result.accepted).toBe(true);
        expect(schedulerTickSpy).not.toHaveBeenCalled();
        expect(output).toContain('[LogInspection] read_recent file=runtime-errors.jsonl');
        expect(output).toContain('[IssueCluster]');
        expect(output).toContain('[SeverityEscalation]');
        expect(output).toContain('stage=\"candidate_collection\"');
        expect(output).toContain('stage=\"candidate_screening\"');
        expect(output).toContain('[CandidateScreening]');
        logSpy.mockRestore();
    });

    it('manual run with empty logs completes cleanly with no candidates', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const result = await (service as any).runManualReflectionNow('engineering', 'manual');
        const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');

        expect(result.accepted).toBe(true);
        expect(result.reason).toBe('no_candidates');
        expect(output).toContain('stage=\"candidate_collection\"');
        expect(output).toContain('stage=\"candidate_screening\"');
        expect(output).toContain('reason=\"severity_low\"');
        logSpy.mockRestore();
    });
});

