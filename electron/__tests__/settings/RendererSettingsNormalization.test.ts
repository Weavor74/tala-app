import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SETTINGS,
    normalizeAppSettingsForRenderer,
    normalizeWorkspaceSettingsForRenderer,
} from '../../../src/renderer/settingsData';

describe('RendererSettingsNormalization', () => {
    it('repairs malformed global agent profiles to a safe non-empty shape', () => {
        const issues: Array<{ path: string; reason: string }> = [];
        const normalized = normalizeAppSettingsForRenderer({
            ...DEFAULT_SETTINGS,
            agent: {
                activeProfileId: 'missing-profile',
                profiles: [],
                capabilities: { memory: true, emotions: true },
            },
        }, (issue) => issues.push(issue));

        expect(Array.isArray(normalized.agent.profiles)).toBe(true);
        expect(normalized.agent.profiles.length).toBeGreaterThan(0);
        expect(normalized.agent.activeProfileId).toBe(normalized.agent.profiles[0].id);
        expect(issues.some((issue) => issue.path === 'agent.profiles')).toBe(true);
        expect(issues.some((issue) => issue.path === 'agent.activeProfileId')).toBe(true);
    });

    it('repairs malformed workspace agent overrides to a safe non-empty shape', () => {
        const normalized = normalizeWorkspaceSettingsForRenderer({
            agent: {
                activeProfileId: 'ghost',
                profiles: null,
            },
        });

        expect(normalized.agent).toBeDefined();
        expect(Array.isArray(normalized.agent?.profiles)).toBe(true);
        expect((normalized.agent?.profiles || []).length).toBeGreaterThan(0);
        expect(normalized.agent?.activeProfileId).toBe((normalized.agent?.profiles || [])[0]?.id);
    });

    it('ignores non-object workspace payloads safely', () => {
        const issues: Array<{ path: string; reason: string }> = [];
        expect(normalizeWorkspaceSettingsForRenderer(null, (issue) => issues.push(issue))).toEqual({});
        expect(normalizeWorkspaceSettingsForRenderer('bad')).toEqual({});
        expect(issues.some((issue) => issue.path === 'workspace')).toBe(true);
    });
});
