import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { LocalDatabaseRuntime } from '../electron/services/db/LocalDatabaseRuntime';

// Mock PathResolver
vi.mock('../electron/services/PathResolver', () => ({
  resolveRuntimePath: (subPath: string, override?: string) => override || path.join('D:/APP_ROOT/runtime', subPath),
  resolveDataPath: (subPath: string, override?: string) => override || path.join('D:/APP_ROOT/data', subPath)
}));

describe('LocalDatabaseRuntime', () => {
  it('should use app-root-relative defaults for runtime and data paths', () => {
    const runtime = new LocalDatabaseRuntime();
    const paths = runtime.getRuntimePaths();

    expect(paths.runtimeRoot).toBe(path.join('D:/APP_ROOT/runtime', 'postgres'));
    expect(paths.dataRoot).toBe(path.join('D:/APP_ROOT/data', 'postgres'));
    expect(paths.logsRoot).toBe(path.join('D:/APP_ROOT/data', 'logs', 'postgres'));
  });

  it('should respect path overrides', () => {
    const runtime = new LocalDatabaseRuntime({
      runtimePathOverride: 'C:/custom/runtime',
      dataPathOverride: 'E:/custom/data'
    });
    const paths = runtime.getRuntimePaths();

    expect(paths.runtimeRoot).toBe('C:/custom/runtime');
    expect(paths.dataRoot).toBe('E:/custom/data');
  });

  it('should resolve binary paths correctly within the runtime root', () => {
    const runtime = new LocalDatabaseRuntime();
    const bins = runtime.getBinaryPaths();
    const ext = process.platform === 'win32' ? '.exe' : '';

    expect(bins.postgres).toBe(path.join('D:/APP_ROOT/runtime/postgres/bin', `postgres${ext}`));
  });
});
