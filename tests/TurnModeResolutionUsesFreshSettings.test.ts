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
        `tala-turn-mode-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    fs.writeFileSync(filePath, JSON.stringify({ agentModes: { activeMode, modes: {} } }, null, 2), 'utf-8');
    tempFiles.push(filePath);
    return filePath;
}

describe('TurnModeResolver uses fresh settings', () => {
    afterEach(() => {
        for (const filePath of tempFiles.splice(0)) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });

    it('resolves the next turn from latest persisted mode without stale assistant cache', async () => {
        const settingsPath = createSettingsFile('assistant');
        const settingsManager = {
            settingsPath,
            refreshSettingsFromDisk,
        };

        const first = await resolveModeForTurn({
            turnId: 'turn-1',
            settingsManager,
        });
        expect(first.resolvedMode).toBe('assistant');

        fs.writeFileSync(settingsPath, JSON.stringify({ agentModes: { activeMode: 'rp', modes: {} } }, null, 2), 'utf-8');
        const second = await resolveModeForTurn({
            turnId: 'turn-2',
            settingsManager,
        });
        expect(second.resolvedMode).toBe('rp');
        expect(second.source).toBe('settings_manager');
    });
});

