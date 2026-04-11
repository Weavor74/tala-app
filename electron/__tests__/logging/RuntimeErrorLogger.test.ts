import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeErrorLogger } from '../../services/logging/RuntimeErrorLogger';

describe('RuntimeErrorLogger', () => {
    let tempRoot: string;
    let logPath: string;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-runtime-error-'));
        logPath = path.join(tempRoot, 'runtime-errors.jsonl');
        (RuntimeErrorLogger as any).initialized = false;
        (RuntimeErrorLogger as any).logFilePath = logPath;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('writes a valid JSONL entry', async () => {
        await RuntimeErrorLogger.logAsync({
            source: 'ipc',
            component: 'FileService',
            event: 'read-file',
            code: 'FILE_READ_ERROR',
            message: 'File not found',
            stack: 'stack',
            metadata: { path: 'missing.txt' },
        });

        const content = fs.readFileSync(logPath, 'utf-8').trim();
        const parsed = JSON.parse(content);
        expect(parsed.event).toBe('read-file');
        expect(parsed.code).toBe('FILE_READ_ERROR');
        expect(parsed.level).toBe('error');
    });

    it('appends multiple entries as separate JSONL lines', async () => {
        await RuntimeErrorLogger.logAsync({
            source: 'process',
            component: 'main',
            event: 'uncaughtException',
            message: 'boom',
        });
        await RuntimeErrorLogger.logAsync({
            source: 'ipc',
            component: 'IpcRouter',
            event: 'settings:get',
            message: 'failed',
        });

        const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(2);
        expect(JSON.parse(lines[0]).event).toBe('uncaughtException');
        expect(JSON.parse(lines[1]).event).toBe('settings:get');
    });

    it('handles undefined stack safely', async () => {
        await RuntimeErrorLogger.logAsync({
            source: 'system',
            component: 'Bootstrap',
            event: 'startup_error',
            message: 'missing dependency',
        });

        const parsed = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
        expect(parsed.stack).toBeUndefined();
        expect(parsed.message).toBe('missing dependency');
    });

    it('does not throw when append fails', async () => {
        vi.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('append_failed'));
        await expect(RuntimeErrorLogger.logAsync({
            source: 'ipc',
            component: 'IpcRouter',
            event: 'read-file',
            message: 'failure',
        })).resolves.toBeUndefined();
    });
});

