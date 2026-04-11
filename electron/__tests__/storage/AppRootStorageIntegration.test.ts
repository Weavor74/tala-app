import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ROOT } from '../../services/PathResolver';

describe('App-root storage integration', () => {
    beforeEach(() => {
        fs.mkdirSync(path.join(APP_ROOT, 'data'), { recursive: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(path.join(APP_ROOT, 'data', 'reflection'), { recursive: true, force: true });
        fs.rmSync(path.join(APP_ROOT, 'data', 'logs'), { recursive: true, force: true });
    });

    it('keeps log sources and runtime-error logs under app-root data/logs', async () => {
        const { LogViewerService } = await import('../../services/LogViewerService');
        const service = new LogViewerService();
        const sources = await service.listSources();
        const logsRoot = path.join(APP_ROOT, 'data', 'logs');

        for (const src of sources) {
            expect(src.filePath.startsWith(logsRoot)).toBe(true);
        }

        await service.logRuntimeError(new Error('storage-test-runtime-error'), {
            source: 'test',
            subsystem: 'app',
            eventType: 'runtime_storage_test',
            processType: 'main',
        });

        expect(fs.existsSync(path.join(logsRoot, 'runtime-errors.jsonl'))).toBe(true);
    });

    it('stores reflection artifacts under app-root data/reflection and avoids data/data duplication', async () => {
        const { ArtifactStore } = await import('../../services/reflection/ArtifactStore');
        const { ReflectionDataDirectories } = await import('../../services/reflection/DataDirectoryPaths');

        const dirs = new ReflectionDataDirectories(path.join(APP_ROOT, 'data'));
        expect(dirs.reflectionsRoot).toBe(path.join(APP_ROOT, 'data', 'reflection'));

        const store = new ArtifactStore(APP_ROOT);
        await store.saveReflection({
            id: 'refl-1',
            timestamp: new Date().toISOString(),
            summary: 'Storage verification',
            evidence: { turns: [], errors: [], failedToolCalls: [] },
            observations: ['ok'],
            metrics: { averageLatencyMs: 1, errorRate: 0 },
        });

        const reflectionPath = path.join(APP_ROOT, 'data', 'reflection', 'artifacts', 'reflections', 'refl-1.json');
        expect(fs.existsSync(reflectionPath)).toBe(true);
    });
});
