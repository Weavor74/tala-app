/**
 * Minimal Electron mock for testing Node-side code that imports from 'electron'.
 * Only stubs the parts actually used by reflection/service code.
 */

export const ipcMain = {
    handle: (_channel: string, _handler: any) => { },
    on: (_channel: string, _handler: any) => { },
    removeHandler: (_channel: string) => { },
};

export const BrowserWindow = {
    getAllWindows: () => [] as any[],
};

export const dialog = {
    showSaveDialog: async (_options: any) => ({ canceled: true, filePath: undefined }),
    showOpenDialog: async (_options: any) => ({ canceled: true, filePaths: [] }),
};

export const app = {
    getPath: (name: string) => `/tmp/tala-test/${name}`,
    getAppPath: () => '/tmp/tala-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
};

export default { ipcMain, BrowserWindow, dialog, app };
