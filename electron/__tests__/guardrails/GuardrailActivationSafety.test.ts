import { evaluateGuardrailProfileActivationSafety } from '../../../shared/guardrails/guardrailActivationSafety';
import type { GuardrailProfilePreflightResult } from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';

function preflight(status: 'ready' | 'degraded' | 'blocked'): GuardrailProfilePreflightResult {
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
        issues: [],
    };
}

describe('Guardrail profile activation safety', () => {
    it('blocks activation when preflight is blocked', () => {
        const decision = evaluateGuardrailProfileActivationSafety(preflight('blocked'));
        expect(decision.allowActivation).toBe(false);
        expect(decision.warnUser).toBe(true);
    });

    it('allows activation with warning when preflight is degraded', () => {
        const decision = evaluateGuardrailProfileActivationSafety(preflight('degraded'));
        expect(decision.allowActivation).toBe(true);
        expect(decision.warnUser).toBe(true);
    });

    it('allows activation silently when preflight is ready', () => {
        const decision = evaluateGuardrailProfileActivationSafety(preflight('ready'));
        expect(decision.allowActivation).toBe(true);
        expect(decision.warnUser).toBe(false);
    });
});

