import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { SystemService } from '../electron/services/SystemService';

// Mock PathResolver
vi.mock('../electron/services/PathResolver', () => ({
  resolveAppPath: (subPath: string) => path.join('D:/APP_ROOT', subPath)
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('3.11.0')
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn()
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn()
}));

describe('SystemService', () => {
  let service: SystemService;

  beforeEach(() => {
    service = new SystemService();
    vi.clearAllMocks();
  });

  it('should include app-root-relative candidates for bundled python', async () => {
    (fs.existsSync as any).mockReturnValue(false);
    
    // We expect it to try candidates like D:/APP_ROOT/bin/python-win/python.exe
    await service.detectEnv();
    
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(path.join('D:', 'APP_ROOT', 'bin')));
  });
});
