/**
 * GuardrailPolicySettings.test.ts
 *
 * Tests for the settings round-trip serialisation and migration of
 * GuardrailPolicyConfig within AppSettings.
 *
 * Validates:
 *   - Default settings include a valid GuardrailPolicyConfig.
 *   - migrateSettings() preserves a valid guardrailPolicy from loaded settings.
 *   - migrateSettings() initialises a default guardrailPolicy when none exists.
 *   - migrateSettings() ignores a guardrailPolicy with wrong version.
 *   - Builder save/load round-trip: config written to settings is read back intact.
 *   - Policy profiles, rules, and validator bindings survive settings migration.
 *   - Policy config with local and remote validator bindings persists correctly.
 *
 * No DB, no IPC, no Electron, no renderer dependencies.
 * Imports from shared/ and src/renderer/settingsData only.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/renderer/settingsData';
import {
    buildDefaultGuardrailPolicyConfig,
    type GuardrailPolicyConfig,
    type GuardrailRule,
    type ValidatorBinding,
} from '../shared/guardrails/guardrailPolicyTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTestRule(): GuardrailRule {
    const now = new Date().toISOString();
    return {
        id: 'test-rule-1',
        name: 'Block file_write in RP',
        description: 'Deny direct file writes when in rp mode',
        enabled: true,
        scopes: [{ mode: 'rp' }, { capability: 'fs_write' }],
        severity: 'high',
        action: 'deny',
        validatorBindings: [],
        createdAt: now,
        updatedAt: now,
    };
}

function makeLocalBinding(): ValidatorBinding {
    return {
        id: 'local-binding-1',
        name: 'Toxic Language (Local)',
        providerKind: 'local_guardrails_ai',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        validatorName: 'ToxicLanguage',
        validatorArgs: { threshold: 0.7 },
        failOpen: false,
        priority: 0,
    };
}

function makeRemoteBinding(): ValidatorBinding {
    return {
        id: 'remote-binding-1',
        name: 'PII Check (Remote)',
        providerKind: 'remote_guardrails_service',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        endpointUrl: 'https://guard.example.com/v1/check',
        timeoutMs: 5000,
        failOpen: true,
        priority: 1,
    };
}

// ─── DEFAULT_SETTINGS ─────────────────────────────────────────────────────────

describe('DEFAULT_SETTINGS — guardrailPolicy', () => {
    it('GPS1: DEFAULT_SETTINGS includes a guardrailPolicy field', () => {
        expect(DEFAULT_SETTINGS.guardrailPolicy).toBeDefined();
    });

    it('GPS2: default guardrailPolicy has version=1', () => {
        expect(DEFAULT_SETTINGS.guardrailPolicy?.version).toBe(1);
    });

    it('GPS3: default guardrailPolicy has activeProfileId="balanced"', () => {
        expect(DEFAULT_SETTINGS.guardrailPolicy?.activeProfileId).toBe('balanced');
    });

    it('GPS4: default guardrailPolicy has three profiles', () => {
        expect(DEFAULT_SETTINGS.guardrailPolicy?.profiles).toHaveLength(3);
    });

    it('GPS5: default guardrailPolicy has empty rules and validatorBindings', () => {
        expect(DEFAULT_SETTINGS.guardrailPolicy?.rules).toEqual([]);
        expect(DEFAULT_SETTINGS.guardrailPolicy?.validatorBindings).toEqual([]);
    });

    it('GPS6: DEFAULT_SETTINGS.guardrailPolicy is JSON-serialisable', () => {
        const serialised = JSON.stringify(DEFAULT_SETTINGS.guardrailPolicy);
        expect(() => JSON.parse(serialised)).not.toThrow();
    });
});

// ─── migrateSettings() — guardrailPolicy preservation ────────────────────────

describe('migrateSettings() — guardrailPolicy', () => {
    it('GPS7: preserves a valid guardrailPolicy from loaded settings', () => {
        const rule = makeTestRule();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            rules: [rule],
            profiles: buildDefaultGuardrailPolicyConfig().profiles.map(p =>
                p.id === 'balanced' ? { ...p, ruleIds: [rule.id] } : p
            ),
        };
        const loaded: any = { ...DEFAULT_SETTINGS, guardrailPolicy: policy };
        const result = migrateSettings(loaded);
        expect(result.guardrailPolicy).toEqual(policy);
    });

    it('GPS8: initialises default guardrailPolicy when loaded settings has none', () => {
        const loaded: any = { ...DEFAULT_SETTINGS, guardrailPolicy: undefined };
        const result = migrateSettings(loaded);
        expect(result.guardrailPolicy).toBeDefined();
        expect(result.guardrailPolicy?.version).toBe(1);
    });

    it('GPS9: ignores guardrailPolicy with wrong version', () => {
        const badPolicy = { version: 99, activeProfileId: 'balanced', profiles: [], rules: [], validatorBindings: [], updatedAt: '' };
        const loaded: any = { ...DEFAULT_SETTINGS, guardrailPolicy: badPolicy };
        const result = migrateSettings(loaded);
        // Should fall back to default (version mismatch not preserved)
        expect(result.guardrailPolicy?.version).toBe(1);
        expect(result.guardrailPolicy?.profiles).toHaveLength(3);
    });

    it('GPS10: preserves rules array through migration', () => {
        const rule = makeTestRule();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            rules: [rule],
        };
        const result = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        expect(result.guardrailPolicy?.rules).toHaveLength(1);
        expect(result.guardrailPolicy?.rules[0].id).toBe(rule.id);
    });

    it('GPS11: preserves validatorBindings array through migration', () => {
        const localBinding = makeLocalBinding();
        const remoteBinding = makeRemoteBinding();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [localBinding, remoteBinding],
        };
        const result = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        expect(result.guardrailPolicy?.validatorBindings).toHaveLength(2);
    });
});

// ─── Builder save/load round-trip ─────────────────────────────────────────────

describe('Builder save/load — round-trip serialisation', () => {
    it('GPS12: full config with rule + scopes + profiles + bindings round-trips via JSON', () => {
        const rule = makeTestRule();
        const localBinding = makeLocalBinding();
        const remoteBinding = makeRemoteBinding();
        const ruleWithBindings: GuardrailRule = { ...rule, validatorBindings: [localBinding] };
        const policy: GuardrailPolicyConfig = {
            version: 1,
            activeProfileId: 'locked_down',
            profiles: buildDefaultGuardrailPolicyConfig().profiles.map(p =>
                p.id === 'locked_down' ? { ...p, ruleIds: [rule.id] } : p
            ),
            rules: [ruleWithBindings],
            validatorBindings: [localBinding, remoteBinding],
            updatedAt: new Date().toISOString(),
        };
        // Simulate save: JSON serialise
        const serialised = JSON.stringify(policy);
        // Simulate load: JSON parse
        const loaded: GuardrailPolicyConfig = JSON.parse(serialised);
        expect(loaded.version).toBe(1);
        expect(loaded.activeProfileId).toBe('locked_down');
        expect(loaded.rules).toHaveLength(1);
        expect(loaded.rules[0].scopes).toHaveLength(2);
        expect(loaded.validatorBindings).toHaveLength(2);
    });

    it('GPS13: local validator binding fields survive settings round-trip', () => {
        const binding = makeLocalBinding();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [binding],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const rt = loaded.guardrailPolicy?.validatorBindings[0];
        expect(rt?.providerKind).toBe('local_guardrails_ai');
        expect(rt?.validatorName).toBe('ToxicLanguage');
        expect((rt?.validatorArgs as any)?.threshold).toBe(0.7);
        expect(rt?.failOpen).toBe(false);
    });

    it('GPS14: remote validator binding fields survive settings round-trip', () => {
        const binding = makeRemoteBinding();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [binding],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const rt = loaded.guardrailPolicy?.validatorBindings[0];
        expect(rt?.providerKind).toBe('remote_guardrails_service');
        expect(rt?.endpointUrl).toBe('https://guard.example.com/v1/check');
        expect(rt?.timeoutMs).toBe(5000);
        expect(rt?.failOpen).toBe(true);
    });

    it('GPS15: profile ruleIds survive settings round-trip', () => {
        const rule = makeTestRule();
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            rules: [rule],
            profiles: buildDefaultGuardrailPolicyConfig().profiles.map(p =>
                p.id === 'balanced' ? { ...p, ruleIds: [rule.id] } : p
            ),
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const balanced = loaded.guardrailPolicy?.profiles.find(p => p.id === 'balanced');
        expect(balanced?.ruleIds).toContain(rule.id);
    });

    it('GPS16: activeProfileId change survives settings round-trip', () => {
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            activeProfileId: 'locked_down',
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        expect(loaded.guardrailPolicy?.activeProfileId).toBe('locked_down');
    });

    it('GPS17: OPA binding fields survive settings round-trip', () => {
        const binding: ValidatorBinding = {
            id: 'opa-binding-1',
            name: 'OPA Policy Check',
            providerKind: 'remote_opa',
            enabled: true,
            executionScopes: [],
            supportedActions: ['require_validation'],
            endpointUrl: 'https://opa.example.com',
            policyModule: 'data/policy/guardrails',
            ruleName: 'allow',
            timeoutMs: 8000,
            failOpen: false,
            priority: 2,
        };
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [binding],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const rt = loaded.guardrailPolicy?.validatorBindings[0];
        expect(rt?.providerKind).toBe('remote_opa');
        expect(rt?.policyModule).toBe('data/policy/guardrails');
        expect(rt?.ruleName).toBe('allow');
    });

    it('GPS18: NeMo Guardrails binding fields survive settings round-trip', () => {
        const binding: ValidatorBinding = {
            id: 'nemo-binding-1',
            name: 'NeMo Safe Assistant',
            providerKind: 'local_nemo_guardrails',
            enabled: true,
            executionScopes: [],
            supportedActions: ['require_validation'],
            railSet: 'safe_assistant',
            failOpen: false,
            priority: 0,
        };
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [binding],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const rt = loaded.guardrailPolicy?.validatorBindings[0];
        expect(rt?.providerKind).toBe('local_nemo_guardrails');
        expect(rt?.railSet).toBe('safe_assistant');
    });

    it('GPS19: Presidio binding fields survive settings round-trip', () => {
        const binding: ValidatorBinding = {
            id: 'presidio-binding-1',
            name: 'Presidio PII',
            providerKind: 'local_presidio',
            enabled: true,
            executionScopes: [],
            supportedActions: ['require_validation'],
            entityTypes: ['PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER'],
            failOpen: false,
            priority: 0,
        };
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            validatorBindings: [binding],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        const rt = loaded.guardrailPolicy?.validatorBindings[0];
        expect(rt?.entityTypes).toEqual(['PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER']);
    });

    it('GPS20: disabled rule survives round-trip with enabled=false', () => {
        const rule = makeTestRule();
        const disabled = { ...rule, enabled: false };
        const policy: GuardrailPolicyConfig = {
            ...buildDefaultGuardrailPolicyConfig(),
            rules: [disabled],
        };
        const loaded = migrateSettings({ ...DEFAULT_SETTINGS, guardrailPolicy: policy });
        expect(loaded.guardrailPolicy?.rules[0].enabled).toBe(false);
    });
});

