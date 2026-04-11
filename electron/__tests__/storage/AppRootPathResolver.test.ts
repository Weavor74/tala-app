import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ROOT } from '../../services/PathResolver';

describe('PathResolver app-root storage defaults', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves logs/cache/temp to app-root-relative data directories', async () => {
        const {
            resolveLogsPath,
            resolveCachePath,
            resolveTempPath,
            DATA_ROOT,
        } = await import('../../services/PathResolver');

        expect(DATA_ROOT).toBe(path.join(APP_ROOT, 'data'));
        expect(resolveLogsPath()).toBe(path.join(APP_ROOT, 'data', 'logs'));
        expect(resolveCachePath()).toBe(path.join(APP_ROOT, 'data', 'cache'));
        expect(resolveTempPath()).toBe(path.join(APP_ROOT, 'data', 'temp'));
    });

    it('warns when a Tala-owned path override escapes app root unexpectedly', async () => {
        const { resolveDataPath } = await import('../../services/PathResolver');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const escaped = path.join(os.tmpdir(), 'outside-root', 'logs');

        const resolved = resolveDataPath('logs', escaped);

        expect(resolved).toBe(escaped);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[PathGuard] write escaped app root'));
    });

    it('allows explicit external paths when marked external-by-configuration', async () => {
        const { resolveDataPath } = await import('../../services/PathResolver');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const externalPath = path.join(os.tmpdir(), 'configured-external', 'logs');

        const resolved = resolveDataPath('logs', externalPath, {
            externalByConfiguration: true,
            label: 'configured-log-path',
        });

        expect(resolved).toBe(externalPath);
        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[PathGuard] external-by-configuration'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('write escaped app root'));
    });
});
