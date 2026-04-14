import {
    buildDefaultGuardrailPolicyConfig,
    cloneGuardrailProfile,
    createBlankGuardrailProfile,
    deleteGuardrailProfile,
    normalizeGuardrailPolicyConfig,
    renameGuardrailProfile,
    setActiveGuardrailProfile,
} from '../../../shared/guardrails/guardrailPolicyTypes';
import { PolicyGate } from '../../services/policy/PolicyGate';

describe('Guardrail profile operations', () => {
    it('protects built-in profiles from rename/delete', () => {
        const base = buildDefaultGuardrailPolicyConfig();
        const builtIn = base.profiles.find(p => p.isBuiltIn);
        expect(builtIn).toBeTruthy();

        expect(() =>
            renameGuardrailProfile(base, builtIn!.id, 'Renamed'),
        ).toThrow('cannot be renamed');

        expect(() =>
            deleteGuardrailProfile(base, builtIn!.id),
        ).toThrow('cannot be deleted');
    });

    it('clones profile as editable custom profile', () => {
        const base = buildDefaultGuardrailPolicyConfig();
        const cloned = cloneGuardrailProfile(base, 'casual', 'Casual Copy');
        const cloneProfile = cloned.profiles.find(p => p.name === 'Casual Copy');

        expect(cloneProfile).toBeTruthy();
        expect(cloneProfile!.isBuiltIn).toBe(false);
        expect(cloneProfile!.ruleIds).toEqual(
            base.profiles.find(p => p.id === 'casual')!.ruleIds,
        );
        expect(cloned.activeProfileId).toBe(cloneProfile!.id);
    });

    it('supports custom profile lifecycle (create, rename, delete)', () => {
        const base = buildDefaultGuardrailPolicyConfig();
        const created = createBlankGuardrailProfile(base, 'Temp Profile');
        const temp = created.profiles.find(p => p.name === 'Temp Profile');
        expect(temp).toBeTruthy();
        expect(temp!.isBuiltIn).toBe(false);

        const renamed = renameGuardrailProfile(created, temp!.id, 'Renamed Temp');
        expect(renamed.profiles.find(p => p.id === temp!.id)?.name).toBe('Renamed Temp');

        const deleted = deleteGuardrailProfile(renamed, temp!.id);
        expect(deleted.profiles.some(p => p.id === temp!.id)).toBe(false);
    });

    it('normalizes legacy built-ins to protected new built-ins', () => {
        const normalized = normalizeGuardrailPolicyConfig({
            ...buildDefaultGuardrailPolicyConfig(),
            activeProfileId: 'balanced',
            profiles: [
                { id: 'permissive', name: 'Permissive', ruleIds: [], readonly: true, isBuiltIn: false },
                { id: 'balanced', name: 'Balanced', ruleIds: [], readonly: true, isBuiltIn: false },
                { id: 'locked_down', name: 'Locked Down', ruleIds: [], readonly: true, isBuiltIn: false },
            ],
        });

        expect(normalized.profiles.some(p => p.id === 'unrestricted' && p.isBuiltIn)).toBe(true);
        expect(normalized.profiles.some(p => p.id === 'casual' && p.isBuiltIn)).toBe(true);
        expect(normalized.profiles.some(p => p.id === 'business_only' && p.isBuiltIn)).toBe(true);
    });
});

describe('Guardrail profile switching', () => {
    it('changes applied rules when active profile changes', async () => {
        const gate = new PolicyGate();

        const casualConfig = setActiveGuardrailProfile(
            buildDefaultGuardrailPolicyConfig(),
            'casual',
        );
        gate.setConfig(casualConfig);
        const casualDecision = await gate.checkSideEffectAsync({
            actionKind: 'tool_invoke',
            executionMode: 'assistant',
            capability: 'shell_run',
        });
        expect(casualDecision.allowed).toBe(true);

        const businessConfig = setActiveGuardrailProfile(casualConfig, 'business_only');
        gate.setConfig(businessConfig);
        const businessDecision = await gate.checkSideEffectAsync({
            actionKind: 'tool_invoke',
            executionMode: 'assistant',
            capability: 'shell_run',
        });

        expect(businessDecision.allowed).toBe(false);
        expect(businessDecision.code).toContain('RULE_DENY:builtin-deny-shell-run');
    });
});

