import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: ['node_modules', 'dist', 'dist-electron'],
        testTimeout: 10000,
        // Mock Electron modules that aren't available in Node context
        alias: {
            electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
        },
    },
    resolve: {
        alias: {
            electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
        },
    },
});
