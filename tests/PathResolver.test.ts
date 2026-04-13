import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { resolveAppPath, resolveStoragePath, resolveRuntimePath, APP_ROOT, appStorageRootPath } from '../electron/services/PathResolver';

// Mock Electron app
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'D:/src/client1/tala-app',
    getPath: (name: string) => {
      if (name === 'exe') return 'D:/src/client1/tala-app/Tala.exe';
      if (name === 'userData') return 'D:/src/client1/tala-app/data';
      return '';
    }
  }
}));

describe('PathResolver', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should resolve APP_ROOT correctly in development', () => {
    expect(APP_ROOT).toBe(path.normalize('D:/src/client1/tala-app'));
  });

  it('should resolve appStorageRootPath correctly', () => {
    expect(appStorageRootPath).toBe(path.join(APP_ROOT, 'data'));
  });

  it('should resolveAppPath relative to app root', () => {
    const result = resolveAppPath('test/path');
    expect(result).toBe(path.resolve(APP_ROOT, 'test/path'));
  });

  it('should resolveAppPath with absolute override', () => {
    const override = process.platform === 'win32' ? 'C:/absolute/path' : '/absolute/path';
    const result = resolveAppPath('test/path', override);
    expect(result).toBe(override);
  });

  it('should resolveAppPath with relative override', () => {
    const override = 'other/relative';
    const result = resolveAppPath('test/path', override);
    expect(result).toBe(path.resolve(APP_ROOT, override));
  });

  it('should resolveStoragePath relative to data root', () => {
    const result = resolveStoragePath('logs/db');
    expect(result).toBe(path.resolve(appStorageRootPath, 'logs/db'));
  });

  it('should resolveRuntimePath relative to runtime folder', () => {
    const result = resolveRuntimePath('postgres');
    expect(result).toBe(path.resolve(APP_ROOT, 'runtime/postgres'));
  });
});


