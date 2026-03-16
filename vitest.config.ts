import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts', 'electron/__tests__/**/*.test.ts'],
        exclude: ['node_modules', 'dist', 'dist-electron'],
        testTimeout: 10000,
        // Mock Electron modules that aren't available in Node context
        alias: {
            electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
        },
    },
    resolve: {
        // Prefer TypeScript source over compiled JavaScript to avoid stale .js artifacts
        // shadowing updated .ts implementations during test runs.
        extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
        alias: {
            electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
        },
    },
});
