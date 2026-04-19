import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk } from '../electron/services/SettingsManager';
import { resolveModeForTurn } from '../electron/services/kernel/TurnModeResolver';

const tempFiles: string[] = [];

function createSettingsFile(activeMode: 'assistant' | 'hybrid' | 'rp'): string {
    const filePath = path.join(
        os.tmpdir(),
        `tala-ui-mode-toggle-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    fs.writeFileSync(filePath, JSON.stringify({ agentModes: { activeMode, modes: {} } }, null, 2), 'utf-8');
    tempFiles.push(filePath);
    return filePath;
}

describe('UI mode toggle next turn', () => {
    afterEach(() => {
        for (const filePath of tempFiles.splice(0)) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });

    it('uses the post-toggle persisted mode on the next turn', async () => {
        const settingsPath = createSettingsFile('assistant');
        fs.writeFileSync(settingsPath, JSON.stringify({ agentModes: { activeMode: 'rp', modes: {} } }, null, 2), 'utf-8');

        const resolution = await resolveModeForTurn({
            turnId: 'turn-ui-toggle',
            sessionId: 'session-ui-toggle',
            requestedMode: 'rp',
            settingsManager: {
                settingsPath,
                refreshSettingsFromDisk,
            },
        });

        expect(resolution.resolvedMode).toBe('rp');
        expect(resolution.source).toBe('settings_manager');
    });
});

