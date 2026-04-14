import { GuardrailActivationDiagnosticsService } from '../../services/guardrails/GuardrailActivationDiagnosticsService';
import type { GuardrailProfilePreflightResult } from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';
import type { GuardrailPolicyConfig } from '../../../shared/guardrails/guardrailPolicyTypes';

function policy(profileId: string): GuardrailPolicyConfig {
    return {
        version: 1,
        activeProfileId: profileId,
        profiles: [{ id: profileId, name: profileId, isBuiltIn: false, ruleIds: [] }],
        rules: [],
        validatorBindings: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

function preflightResult(status: 'ready' | 'degraded' | 'blocked'): GuardrailProfilePreflightResult {
    return {
        checkedAt: '2026-01-01T00:00:00.000Z',
        profileId: 'p-1',
        status,
        providers: [],
        bindings: [],
        summary: {
            providersTotal: 0,
            providersReady: 0,
            providersDegraded: 0,
            providersBlocked: 0,
            bindingsTotal: 0,
            bindingsReady: 0,
            bindingsDegraded: 0,
            bindingsBlocked: 0,
        },
        issues: status === 'ready' ? [] : ['runtime unavailable'],
    };
}

describe('GuardrailActivationDiagnosticsService', () => {
    it.each([
        ['ready', 'allow', 'passed'],
        ['degraded', 'warn', 'degraded'],
        ['blocked', 'deny', 'blocked'],
    ] as const)('emits activation event for %s preflight', async (preflightStatus, expectedDecision, expectedStatus) => {
        const telemetry = { emit: vi.fn() };
        const service = new GuardrailActivationDiagnosticsService({
            preflightService: {
                runProfilePreflight: vi.fn(async () => preflightResult(preflightStatus)),
            } as any,
            telemetry: telemetry as any,
        });

        const result = await service.evaluateActivation({
            profileId: 'p-1',
            policy: policy('p-1'),
        });

        expect(result.decisionKind).toBe(expectedDecision);
        expect(telemetry.emit).toHaveBeenCalledWith(expect.objectContaining({
            eventName: 'guardrails.activation',
            decision: expectedDecision,
            status: expectedStatus,
            payload: expect.objectContaining({
                profileId: 'p-1',
                preflightStatus,
                durationMs: expect.any(Number),
            }),
        }));
    });
});
