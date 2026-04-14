import type {
    GuardrailPolicyConfig,
    GuardrailRule,
    ValidatorBinding,
    ValidatorProviderKind,
} from '../../../shared/guardrails/guardrailPolicyTypes';
import { LocalGuardrailsProfilePreflightService } from '../../services/guardrails/LocalGuardrailsProfilePreflightService';
import type { GuardrailValidationResult } from '../../services/guardrails/types';

function binding(
    id: string,
    providerKind: ValidatorProviderKind,
    failOpen: boolean,
): ValidatorBinding {
    return {
        id,
        name: id,
        providerKind,
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        validatorName: 'ToxicLanguage',
        validatorArgs: {},
        failOpen,
        priority: 0,
        timeoutMs: 5000,
    };
}

function rule(id: string, bindings: ValidatorBinding[]): GuardrailRule {
    return {
        id,
        name: id,
        enabled: true,
        description: '',
        scopes: [],
        severity: 'medium',
        action: 'require_validation',
        validatorBindings: bindings,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

function policyWithProfile(profileId: string, rules: GuardrailRule[]): GuardrailPolicyConfig {
    return {
        version: 1,
        activeProfileId: profileId,
        profiles: [
            {
                id: profileId,
                name: 'Test Profile',
                isBuiltIn: false,
                ruleIds: rules.map(r => r.id),
            },
        ],
        rules,
        validatorBindings: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

function passProbeResult(validatorId: string): GuardrailValidationResult {
    return {
        validatorId,
        validatorName: validatorId,
        engineKind: 'local_guardrails_ai',
        success: true,
        passed: true,
        shouldDeny: false,
        violations: [],
        evidence: [],
        warnings: [],
        durationMs: 1,
    };
}

describe('LocalGuardrailsProfilePreflightService', () => {
    it('returns ready when all providers and bindings are healthy', async () => {
        const runtimeHealth = {
            checkReadiness: vi.fn(async () => ({
                providerKind: 'local_guardrails_ai',
                checkedAt: '',
                ready: true,
                python: { resolved: true, path: 'python' },
                runner: { path: '/runtime/guardrails/local_guardrails_runner.py', exists: true },
                guardrails: { importable: true, version: '0.6.3' },
            })),
        };
        const probeService = {
            testBinding: vi.fn(async (input: any) => passProbeResult(input.binding.id)),
        };
        const service = new LocalGuardrailsProfilePreflightService({ runtimeHealth: runtimeHealth as any, probeService: probeService as any });

        const config = policyWithProfile('p-ready', [
            rule('r-1', [binding('b-1', 'local_guardrails_ai', false)]),
        ]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-ready' });

        expect(result.status).toBe('ready');
        expect(result.summary.bindingsBlocked).toBe(0);
        expect(result.summary.bindingsDegraded).toBe(0);
    });

    it('returns degraded when provider is missing but binding is fail-open', async () => {
        const service = new LocalGuardrailsProfilePreflightService({
            runtimeHealth: {
                checkReadiness: vi.fn(async () => ({
                    providerKind: 'local_guardrails_ai',
                    checkedAt: '',
                    ready: false,
                    python: { resolved: false, error: 'Python missing' },
                    runner: { path: '/runtime/guardrails/local_guardrails_runner.py', exists: false },
                    guardrails: { importable: false, error: 'Runner missing' },
                })),
            } as any,
            probeService: {
                testBinding: vi.fn(),
            } as any,
        });

        const config = policyWithProfile('p-degraded', [
            rule('r-1', [binding('b-1', 'local_guardrails_ai', true)]),
        ]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-degraded' });

        expect(result.status).toBe('degraded');
        expect(result.summary.bindingsDegraded).toBe(1);
    });

    it('returns blocked when provider is missing and binding is fail-closed', async () => {
        const service = new LocalGuardrailsProfilePreflightService({
            runtimeHealth: {
                checkReadiness: vi.fn(async () => ({
                    providerKind: 'local_guardrails_ai',
                    checkedAt: '',
                    ready: false,
                    python: { resolved: false, error: 'Python missing' },
                    runner: { path: '/runtime/guardrails/local_guardrails_runner.py', exists: false },
                    guardrails: { importable: false, error: 'Runner missing' },
                })),
            } as any,
            probeService: {
                testBinding: vi.fn(),
            } as any,
        });

        const config = policyWithProfile('p-blocked', [
            rule('r-1', [binding('b-1', 'local_guardrails_ai', false)]),
        ]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-blocked' });

        expect(result.status).toBe('blocked');
        expect(result.summary.bindingsBlocked).toBe(1);
    });

    it('aggregates multi-binding statuses across rules', async () => {
        const runtimeHealth = {
            checkReadiness: vi.fn(async () => ({
                providerKind: 'local_guardrails_ai',
                checkedAt: '',
                ready: true,
                python: { resolved: true, path: 'python' },
                runner: { path: '/runtime/guardrails/local_guardrails_runner.py', exists: true },
                guardrails: { importable: true, version: '0.6.3' },
            })),
        };
        const probeService = {
            testBinding: vi.fn(async (input: any) => {
                if (input.binding.id === 'b-bad') {
                    return {
                        ...passProbeResult(input.binding.id),
                        success: false,
                        error: 'probe failure',
                        shouldDeny: true,
                    };
                }
                return passProbeResult(input.binding.id);
            }),
        };
        const service = new LocalGuardrailsProfilePreflightService({ runtimeHealth: runtimeHealth as any, probeService: probeService as any });

        const config = policyWithProfile('p-multi', [
            rule('r-1', [binding('b-good', 'local_guardrails_ai', false)]),
            rule('r-2', [binding('b-bad', 'local_guardrails_ai', true)]),
        ]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-multi' });

        expect(result.status).toBe('degraded');
        expect(result.summary.bindingsReady).toBe(1);
        expect(result.summary.bindingsDegraded).toBe(1);
        expect(result.summary.bindingsBlocked).toBe(0);
    });

    it('returns ready for profile with no bindings', async () => {
        const service = new LocalGuardrailsProfilePreflightService({
            runtimeHealth: {
                checkReadiness: vi.fn(),
            } as any,
            probeService: {
                testBinding: vi.fn(),
            } as any,
        });

        const config = policyWithProfile('p-empty', [rule('r-empty', [])]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-empty' });

        expect(result.status).toBe('ready');
        expect(result.summary.bindingsTotal).toBe(0);
        expect(result.summary.providersTotal).toBe(0);
    });

    it('enforces local-only behavior and does not probe remote providers', async () => {
        const runtimeHealth = {
            checkReadiness: vi.fn(),
        };
        const probeService = {
            testBinding: vi.fn(),
        };
        const service = new LocalGuardrailsProfilePreflightService({ runtimeHealth: runtimeHealth as any, probeService: probeService as any });

        const config = policyWithProfile('p-remote', [
            rule('r-remote', [binding('b-remote', 'remote_guardrails_service', false)]),
        ]);
        const result = await service.runProfilePreflight({ policy: config, profileId: 'p-remote' });

        expect(result.status).toBe('blocked');
        expect(result.providers[0]?.providerKind).toBe('remote_guardrails_service');
        expect(result.providers[0]?.status).toBe('blocked');
        expect(runtimeHealth.checkReadiness).not.toHaveBeenCalled();
        expect(probeService.testBinding).not.toHaveBeenCalled();
    });
});

