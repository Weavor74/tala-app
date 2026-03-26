/**
 * IpcChannelUniqueness.test.ts
 *
 * Locks in the IPC single-ownership invariant:
 *   Each ipcMain.handle channel must be registered exactly once across the
 *   entire Electron process.
 *
 * TALA INVARIANT (from IpcRouter.ts):
 *   "Each ipcMain.handle channel must be registered EXACTLY ONCE.
 *    Duplicate handlers WILL crash the app and break persistence."
 *
 * Implementation:
 *   We scan source files with a regex rather than executing modules at
 *   runtime — duplicate ipcMain.handle calls crash Electron before any
 *   runtime assertion could be evaluated.
 *
 * Maintenance note:
 *   If a new file gains ipcMain.handle registrations, add its path to
 *   IPC_REGISTRATION_FILES below.
 */

import { describe, it, expect } from 'vitest';
// @ts-ignore
import fs from 'fs';
// @ts-ignore
import path from 'path';

// All files that are permitted to call ipcMain.handle().
// This list is intentionally explicit — additions require a conscious decision.
const IPC_REGISTRATION_FILES = [
    'electron/main.ts',
    'electron/services/IpcRouter.ts',
    'electron/services/reflection/ReflectionAppService.ts',
    'electron/services/soul/SoulService.ts',
    'electron/services/selfModel/SelfModelAppService.ts',
];

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/** Extract all ipcMain.handle channel names from a source file. */
function extractChannels(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Match ipcMain.handle('channel-name', ...) with single or double quotes
    const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
    const channels: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        channels.push(m[1]);
    }
    return channels;
}

describe('IPC channel uniqueness', () => {
    // ── Per-file uniqueness ────────────────────────────────────────────────────

    for (const relPath of IPC_REGISTRATION_FILES) {
        it(`${relPath} has no duplicate handle registrations within the file`, () => {
            const absPath = path.join(REPO_ROOT, relPath);
            const channels = extractChannels(absPath);
            const seen = new Set<string>();
            const duplicates: string[] = [];
            for (const ch of channels) {
                if (seen.has(ch)) duplicates.push(ch);
                seen.add(ch);
            }
            expect(
                duplicates,
                `Duplicate ipcMain.handle registrations within ${relPath}: ${duplicates.join(', ')}`,
            ).toHaveLength(0);
        });
    }

    // ── Cross-file uniqueness ──────────────────────────────────────────────────

    it('no channel registered in IpcRouter.ts is also registered in main.ts', () => {
        const router = new Set(extractChannels(path.join(REPO_ROOT, 'electron/services/IpcRouter.ts')));
        const main = extractChannels(path.join(REPO_ROOT, 'electron/main.ts'));
        const overlap = main.filter(ch => router.has(ch));
        expect(
            overlap,
            `Channels registered in BOTH IpcRouter.ts and main.ts: ${overlap.join(', ')}`,
        ).toHaveLength(0);
    });

    it('no channel registered in IpcRouter.ts is also registered in ReflectionAppService.ts', () => {
        const router = new Set(extractChannels(path.join(REPO_ROOT, 'electron/services/IpcRouter.ts')));
        const reflection = extractChannels(path.join(REPO_ROOT, 'electron/services/reflection/ReflectionAppService.ts'));
        const overlap = reflection.filter(ch => router.has(ch));
        expect(
            overlap,
            `Channels registered in BOTH IpcRouter.ts and ReflectionAppService.ts: ${overlap.join(', ')}`,
        ).toHaveLength(0);
    });

    it('no channel registered in IpcRouter.ts is also registered in SoulService.ts', () => {
        const router = new Set(extractChannels(path.join(REPO_ROOT, 'electron/services/IpcRouter.ts')));
        const soul = extractChannels(path.join(REPO_ROOT, 'electron/services/soul/SoulService.ts'));
        const overlap = soul.filter(ch => router.has(ch));
        expect(
            overlap,
            `Channels registered in BOTH IpcRouter.ts and SoulService.ts: ${overlap.join(', ')}`,
        ).toHaveLength(0);
    });

    it('no channel registered in IpcRouter.ts is also registered in SelfModelAppService.ts', () => {
        const router = new Set(extractChannels(path.join(REPO_ROOT, 'electron/services/IpcRouter.ts')));
        const selfModel = extractChannels(path.join(REPO_ROOT, 'electron/services/selfModel/SelfModelAppService.ts'));
        const overlap = selfModel.filter(ch => router.has(ch));
        expect(
            overlap,
            `Channels registered in BOTH IpcRouter.ts and SelfModelAppService.ts: ${overlap.join(', ')}`,
        ).toHaveLength(0);
    });

    it('retrieval:refreshExternalProvider is registered exactly once across all IPC files', () => {
        const CHANNEL = 'retrieval:refreshExternalProvider';
        let count = 0;
        for (const relPath of IPC_REGISTRATION_FILES) {
            const absPath = path.join(REPO_ROOT, relPath);
            const channels = extractChannels(absPath);
            count += channels.filter(ch => ch === CHANNEL).length;
        }
        expect(
            count,
            `Expected exactly one registration of '${CHANNEL}', found ${count}`,
        ).toBe(1);
    });

    it('the complete set of all handle registrations across all IPC files has no duplicates', () => {
        const all: Array<{ channel: string; file: string }> = [];
        for (const relPath of IPC_REGISTRATION_FILES) {
            const absPath = path.join(REPO_ROOT, relPath);
            for (const ch of extractChannels(absPath)) {
                all.push({ channel: ch, file: relPath });
            }
        }
        const seen = new Map<string, string>();
        const duplicates: string[] = [];
        for (const { channel, file } of all) {
            if (seen.has(channel)) {
                duplicates.push(`'${channel}' in both ${seen.get(channel)} and ${file}`);
            } else {
                seen.set(channel, file);
            }
        }
        expect(
            duplicates,
            `Duplicate IPC channel registrations detected:\n${duplicates.join('\n')}`,
        ).toHaveLength(0);
    });
});
