/**
 * GuardrailPolicyTypes.test.ts
 *
 * Unit tests for the GuardrailPolicyConfig model.
 *
 * Validates:
 *   - makeDefaultGuardrailPolicyConfig() produces a valid, serialisable config.
 *   - All required fields are populated in the default config.
 *   - The default config has three built-in profiles.
 *   - GuardrailPolicyConfig is round-trip serialisable through JSON.
 *   - ValidatorBinding fields for all provider kinds are correctly structured.
 *   - VALIDATOR_PROVIDER_REGISTRY contains all expected provider kinds.
 *   - GuardrailRule structure is valid when created manually.
 *   - GuardrailProfile structure is valid.
 *
 * No DB, no IPC, no Electron, no renderer.
 */

import { describe, it, expect } from 'vitest';
import {
    makeDefaultGuardrailPolicyConfig,
    VALIDATOR_PROVIDER_REGISTRY,
    type GuardrailPolicyConfig,
    type GuardrailProfile,
    type GuardrailRule,
    type ValidatorBinding,
    type ValidatorProviderKind,
} from '../shared/guardrails/guardrailPolicyTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<GuardrailRule> = {}): GuardrailRule {
    const now = new Date().toISOString();
    return {
        id: 'test-rule-1',
        name: 'Test Rule',
        description: 'A test rule',
        enabled: true,
        scopes: [],
        severity: 'medium',
        action: 'warn',
        validatorBindings: [],
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function makeBinding(overrides: Partial<ValidatorBinding> = {}): ValidatorBinding {
    return {
        id: 'test-binding-1',
        name: 'Test Binding',
        providerKind: 'local_guardrails_ai',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        failOpen: false,
        priority: 0,
        ...overrides,
    };
}

// ─── makeDefaultGuardrailPolicyConfig() ──────────────────────────────────────

describe('makeDefaultGuardrailPolicyConfig()', () => {
    it('GPT1: returns a config with version=1', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(cfg.version).toBe(1);
    });

    it('GPT2: has activeProfileId set to "balanced"', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(cfg.activeProfileId).toBe('balanced');
    });

    it('GPT3: has exactly three built-in profiles', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(cfg.profiles).toHaveLength(3);
    });

    it('GPT4: profile IDs are permissive, balanced, locked_down', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        const ids = cfg.profiles.map(p => p.id);
        expect(ids).toContain('permissive');
        expect(ids).toContain('balanced');
        expect(ids).toContain('locked_down');
    });

    it('GPT5: all built-in profiles have readonly=true', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        for (const p of cfg.profiles) {
            expect(p.readonly).toBe(true);
        }
    });

    it('GPT6: all profiles start with empty ruleIds', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        for (const p of cfg.profiles) {
            expect(p.ruleIds).toEqual([]);
        }
    });

    it('GPT7: rules array starts empty', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(cfg.rules).toEqual([]);
    });

    it('GPT8: validatorBindings array starts empty', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(cfg.validatorBindings).toEqual([]);
    });

    it('GPT9: updatedAt is a valid ISO-8601 timestamp', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        expect(() => new Date(cfg.updatedAt)).not.toThrow();
        expect(new Date(cfg.updatedAt).toISOString()).toBe(cfg.updatedAt);
    });

    it('GPT10: all profiles have non-empty name and description', () => {
        const cfg = makeDefaultGuardrailPolicyConfig();
        for (const p of cfg.profiles) {
            expect(p.name.length).toBeGreaterThan(0);
            expect(p.description!.length).toBeGreaterThan(0);
        }
    });
});

// ─── JSON round-trip serialisation ───────────────────────────────────────────

describe('GuardrailPolicyConfig — JSON round-trip', () => {
    it('GPT11: default config survives JSON.stringify → JSON.parse unchanged', () => {
        const original = makeDefaultGuardrailPolicyConfig();
        const roundTripped: GuardrailPolicyConfig = JSON.parse(JSON.stringify(original));
        expect(roundTripped).toEqual(original);
    });

    it('GPT12: config with rules and bindings round-trips correctly', () => {
        const rule = makeRule();
        const binding = makeBinding();
        const cfg: GuardrailPolicyConfig = {
            ...makeDefaultGuardrailPolicyConfig(),
            rules: [{ ...rule, validatorBindings: [binding] }],
            validatorBindings: [binding],
        };
        const roundTripped: GuardrailPolicyConfig = JSON.parse(JSON.stringify(cfg));
        expect(roundTripped.rules).toHaveLength(1);
        expect(roundTripped.rules[0].id).toBe(rule.id);
        expect(roundTripped.validatorBindings).toHaveLength(1);
        expect(roundTripped.validatorBindings[0].id).toBe(binding.id);
    });

    it('GPT13: profiles survive round-trip with ruleIds', () => {
        const rule = makeRule();
        const cfg: GuardrailPolicyConfig = {
            ...makeDefaultGuardrailPolicyConfig(),
            rules: [rule],
            profiles: [
                ...makeDefaultGuardrailPolicyConfig().profiles.map(p =>
                    p.id === 'balanced' ? { ...p, ruleIds: [rule.id] } : p
                ),
            ],
        };
        const roundTripped: GuardrailPolicyConfig = JSON.parse(JSON.stringify(cfg));
        const balanced = roundTripped.profiles.find(p => p.id === 'balanced');
        expect(balanced?.ruleIds).toContain(rule.id);
    });
});

// ─── GuardrailRule structure ──────────────────────────────────────────────────

describe('GuardrailRule structure', () => {
    it('GPT14: makeRule() produces a valid rule', () => {
        const rule = makeRule();
        expect(rule.id).toBeDefined();
        expect(rule.name).toBeDefined();
        expect(rule.enabled).toBe(true);
        expect(rule.scopes).toEqual([]);
        expect(rule.validatorBindings).toEqual([]);
        expect(rule.severity).toBe('medium');
        expect(rule.action).toBe('warn');
    });

    it('GPT15: rule with scopes round-trips correctly', () => {
        const rule = makeRule({
            scopes: [
                { mode: 'rp' },
                { executionType: 'chat_turn' },
                { capability: 'fs_write' },
            ],
        });
        const rt: GuardrailRule = JSON.parse(JSON.stringify(rule));
        expect(rt.scopes).toHaveLength(3);
        expect(rt.scopes[0]).toEqual({ mode: 'rp' });
        expect(rt.scopes[1]).toEqual({ executionType: 'chat_turn' });
        expect(rt.scopes[2]).toEqual({ capability: 'fs_write' });
    });

    it('GPT16: rule with all action variants is valid', () => {
        const actions = ['allow', 'deny', 'warn', 'require_validation', 'require_confirmation'] as const;
        for (const action of actions) {
            const rule = makeRule({ action });
            expect(rule.action).toBe(action);
        }
    });

    it('GPT17: rule with all severity variants is valid', () => {
        const severities = ['info', 'low', 'medium', 'high', 'critical'] as const;
        for (const severity of severities) {
            const rule = makeRule({ severity });
            expect(rule.severity).toBe(severity);
        }
    });
});

// ─── ValidatorBinding structure ───────────────────────────────────────────────

describe('ValidatorBinding structure', () => {
    it('GPT18: makeBinding() produces a valid binding', () => {
        const b = makeBinding();
        expect(b.id).toBeDefined();
        expect(b.name).toBeDefined();
        expect(b.providerKind).toBe('local_guardrails_ai');
        expect(b.enabled).toBe(true);
        expect(b.executionScopes).toEqual([]);
        expect(b.supportedActions).toContain('require_validation');
        expect(b.failOpen).toBe(false);
        expect(b.priority).toBe(0);
    });

    it('GPT19: local_guardrails_ai binding with validatorName round-trips', () => {
        const b = makeBinding({ validatorName: 'ToxicLanguage', validatorArgs: { threshold: 0.5 } });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.validatorName).toBe('ToxicLanguage');
        expect(rt.validatorArgs).toEqual({ threshold: 0.5 });
    });

    it('GPT20: local_presidio binding with entityTypes round-trips', () => {
        const b = makeBinding({
            providerKind: 'local_presidio',
            entityTypes: ['PERSON', 'EMAIL_ADDRESS'],
        });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.entityTypes).toEqual(['PERSON', 'EMAIL_ADDRESS']);
    });

    it('GPT21: local_nemo_guardrails binding with railSet round-trips', () => {
        const b = makeBinding({ providerKind: 'local_nemo_guardrails', railSet: 'safe_assistant' });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.railSet).toBe('safe_assistant');
    });

    it('GPT22: local_opa binding with policyModule and ruleName round-trips', () => {
        const b = makeBinding({
            providerKind: 'local_opa',
            policyModule: 'policy/guardrails',
            ruleName: 'allow',
        });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.policyModule).toBe('policy/guardrails');
        expect(rt.ruleName).toBe('allow');
    });

    it('GPT23: remote_guardrails_service binding with endpointUrl round-trips', () => {
        const b = makeBinding({
            providerKind: 'remote_guardrails_service',
            endpointUrl: 'https://guard.example.com/v1/check',
            timeoutMs: 3000,
        });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.endpointUrl).toBe('https://guard.example.com/v1/check');
        expect(rt.timeoutMs).toBe(3000);
    });

    it('GPT24: remote_opa binding with all remote fields round-trips', () => {
        const b = makeBinding({
            providerKind: 'remote_opa',
            endpointUrl: 'https://opa.example.com',
            policyModule: 'data/policy',
            ruleName: 'deny',
            timeoutMs: 10000,
            failOpen: true,
        });
        const rt: ValidatorBinding = JSON.parse(JSON.stringify(b));
        expect(rt.providerKind).toBe('remote_opa');
        expect(rt.endpointUrl).toBe('https://opa.example.com');
        expect(rt.failOpen).toBe(true);
    });
});

// ─── VALIDATOR_PROVIDER_REGISTRY ─────────────────────────────────────────────

describe('VALIDATOR_PROVIDER_REGISTRY', () => {
    const ALL_KINDS: ValidatorProviderKind[] = [
        'local_guardrails_ai',
        'local_presidio',
        'local_nemo_guardrails',
        'local_opa',
        'remote_guardrails_service',
        'remote_nemo_guardrails',
        'remote_opa',
    ];

    it('GPT25: registry contains all 7 expected provider kinds', () => {
        expect(VALIDATOR_PROVIDER_REGISTRY).toHaveLength(7);
    });

    it('GPT26: every expected provider kind has a registry entry', () => {
        for (const kind of ALL_KINDS) {
            const entry = VALIDATOR_PROVIDER_REGISTRY.find(p => p.kind === kind);
            expect(entry, `Missing registry entry for ${kind}`).toBeDefined();
        }
    });

    it('GPT27: local providers have isRemote=false', () => {
        const localKinds: ValidatorProviderKind[] = [
            'local_guardrails_ai', 'local_presidio', 'local_nemo_guardrails', 'local_opa',
        ];
        for (const kind of localKinds) {
            const entry = VALIDATOR_PROVIDER_REGISTRY.find(p => p.kind === kind);
            expect(entry?.isRemote, `${kind} should have isRemote=false`).toBe(false);
        }
    });

    it('GPT28: remote providers have isRemote=true', () => {
        const remoteKinds: ValidatorProviderKind[] = [
            'remote_guardrails_service', 'remote_nemo_guardrails', 'remote_opa',
        ];
        for (const kind of remoteKinds) {
            const entry = VALIDATOR_PROVIDER_REGISTRY.find(p => p.kind === kind);
            expect(entry?.isRemote, `${kind} should have isRemote=true`).toBe(true);
        }
    });

    it('GPT29: all registry entries have non-empty label and description', () => {
        for (const entry of VALIDATOR_PROVIDER_REGISTRY) {
            expect(entry.label.length).toBeGreaterThan(0);
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it('GPT30: all registry entries have requiredFields and optionalFields arrays', () => {
        for (const entry of VALIDATOR_PROVIDER_REGISTRY) {
            expect(Array.isArray(entry.requiredFields)).toBe(true);
            expect(Array.isArray(entry.optionalFields)).toBe(true);
        }
    });
});
