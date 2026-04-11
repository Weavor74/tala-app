import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActiveMode, loadSettings, refreshSettingsFromDisk } from '../../services/SettingsManager';

const tempPaths: string[] = [];

function makeTempSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-settings-'));
    const filePath = path.join(dir, 'app_settings.json');
    tempPaths.push(dir);
    return filePath;
}

afterEach(() => {
    for (const dir of tempPaths.splice(0, tempPaths.length)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore test cleanup failures
        }
    }
});

describe('SettingsManager mode defaults', () => {
    it('startup default resolves to hybrid when no settings file exists', () => {
        const settingsPath = makeTempSettingsPath();
        const settings = loadSettings(settingsPath, 'test.default_mode');
        expect(settings.agentModes?.activeMode).toBe('hybrid');
        expect(getActiveMode(settingsPath, 'test.default_mode.read')).toBe('hybrid');
    });

    it('persisted legacy assistant-mode setting remains readable for compatibility', () => {
        const settingsPath = makeTempSettingsPath();
        fs.writeFileSync(settingsPath, JSON.stringify({ agentModes: { activeMode: 'assistant' } }, null, 2), 'utf-8');
        refreshSettingsFromDisk(settingsPath, 'test.legacy_assistant');
        expect(getActiveMode(settingsPath, 'test.legacy_assistant.read')).toBe('assistant');
    });
});

