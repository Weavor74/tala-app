import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { resolveAppPath, resolveDataPath, resolveRuntimePath, APP_ROOT, DATA_ROOT } from '../electron/services/PathResolver';

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
    expect(APP_ROOT).toBe('D:/src/client1/tala-app');
  });

  it('should resolve DATA_ROOT correctly', () => {
    expect(DATA_ROOT).toBe(path.join(APP_ROOT, 'data'));
  });

  it('should resolveAppPath relative to app root', () => {
    const result = resolveAppPath('test/path');
    expect(result).toBe(path.resolve(APP_ROOT, 'test/path'));
  });

  it('should resolveAppPath with absolute override', () => {
    const override = 'C:/absolute/path';
    const result = resolveAppPath('test/path', override);
    expect(result).toBe(override);
  });

  it('should resolveAppPath with relative override', () => {
    const override = 'other/relative';
    const result = resolveAppPath('test/path', override);
    expect(result).toBe(path.resolve(APP_ROOT, override));
  });

  it('should resolveDataPath relative to data root', () => {
    const result = resolveDataPath('logs/db');
    expect(result).toBe(path.resolve(DATA_ROOT, 'logs/db'));
  });

  it('should resolveRuntimePath relative to runtime folder', () => {
    const result = resolveRuntimePath('postgres');
    expect(result).toBe(path.resolve(APP_ROOT, 'runtime/postgres'));
  });
});
