import type { GuardrailProfilePreflightResult } from './localGuardrailsProfilePreflightTypes';

export interface GuardrailActivationSafetyDecision {
    allowActivation: boolean;
    warnUser: boolean;
    message: string;
}

export function evaluateGuardrailProfileActivationSafety(
    preflight: GuardrailProfilePreflightResult,
): GuardrailActivationSafetyDecision {
    if (preflight.status === 'blocked') {
        return {
            allowActivation: false,
            warnUser: true,
            message: 'Profile activation blocked: preflight reported blocked bindings/providers.',
        };
    }
    if (preflight.status === 'degraded') {
        return {
            allowActivation: true,
            warnUser: true,
            message: 'Profile activated with warnings: preflight reported degraded providers/bindings.',
        };
    }
    return {
        allowActivation: true,
        warnUser: false,
        message: 'Profile preflight ready.',
    };
}

