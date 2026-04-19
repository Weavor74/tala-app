import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('IPCParity', () => {
  it('keeps get-startup-status request/handler parity', () => {
    const preloadSource = fs.readFileSync(path.resolve('electron/preload.ts'), 'utf8');
    const mainSource = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');

    const preloadCallsStartupStatus = preloadSource.includes("ipcRenderer.invoke('get-startup-status')");
    const mainRegistersStartupStatus = mainSource.includes("ipcMain.handle('get-startup-status'");

    expect(preloadCallsStartupStatus).toBe(true);
    expect(mainRegistersStartupStatus).toBe(true);
  });

  it('keeps model settings related IPC channels registered', () => {
    const routerSource = fs.readFileSync(path.resolve('electron/services/IpcRouter.ts'), 'utf8');

    expect(routerSource.includes("ipcMain.handle('save-settings'")).toBe(true);
    expect(routerSource.includes("ipcMain.handle('inference:listProviders'")).toBe(true);
    expect(routerSource.includes("ipcMain.handle('inference:selectProvider'")).toBe(true);
    expect(routerSource.includes("ipcMain.handle('scan-local-providers'")).toBe(true);
  });
});
