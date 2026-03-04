import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadSettings, DEFAULT_SETTINGS } from '../electron/services/SettingsManager';

// Mocking Electron's 'app' since SettingsManager might use it if we import it fully
// But here we only need the logic
vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/tala-test'
    }
}));

describe('Assist Mode Logic', () => {
    const testSettingsPath = '/tmp/tala-test/app_settings.json';

    beforeEach(() => {
        if (!fs.existsSync(path.dirname(testSettingsPath))) {
            fs.mkdirSync(path.dirname(testSettingsPath), { recursive: true });
        }
        if (fs.existsSync(testSettingsPath)) {
            fs.unlinkSync(testSettingsPath);
        }
    });

    it('should have assist profile in DEFAULT_SETTINGS', () => {
        const assist = DEFAULT_SETTINGS.agent.profiles.find(p => p.id === 'assist');
        expect(assist).toBeDefined();
        expect(assist?.name).toBe('Assist');
        expect(assist?.systemPrompt).toContain('Assist Module');
    });

    it('should persist activeMode', () => {
        const settings = loadSettings(testSettingsPath);
        settings.agent.activeMode = 'assist';

        // Mimic saveSettings logic
        fs.writeFileSync(testSettingsPath, JSON.stringify(settings, null, 2));

        const reloaded = loadSettings(testSettingsPath);
        expect(reloaded.agent.activeMode).toBe('assist');
    });

    it('should route to assist profile in assist mode', () => {
        const settings = {
            agent: {
                activeMode: 'assist',
                activeProfileId: 'tala',
                profiles: DEFAULT_SETTINGS.agent.profiles
            }
        };

        const activeMode = settings.agent.activeMode;
        const activeProfileId = activeMode === 'assist' ? 'assist' : (settings.agent.activeProfileId || 'tala');
        const activeProfile = settings.agent.profiles.find(p => p.id === activeProfileId);

        expect(activeProfile?.id).toBe('assist');
    });

    it('should route to tala profile in rp mode', () => {
        const settings = {
            agent: {
                activeMode: 'rp',
                activeProfileId: 'tala',
                profiles: DEFAULT_SETTINGS.agent.profiles
            }
        };

        const activeMode = settings.agent.activeMode;
        const activeProfileId = activeMode === 'assist' ? 'assist' : (settings.agent.activeProfileId || 'tala');
        const activeProfile = settings.agent.profiles.find(p => p.id === activeProfileId);

        expect(activeProfile?.id).toBe('tala');
    });

    it('should detect diagnostic requests and override to assist', () => {
        const userMessage = "list tools and mcp status";
        const isDiagnosticRequest = /list tools|verify|test|mcp|logs/i.test(userMessage);

        const settings = { agent: { activeMode: 'rp' } };
        const activeMode = isDiagnosticRequest ? 'assist' : settings.agent.activeMode;

        expect(activeMode).toBe('assist');
    });
});
