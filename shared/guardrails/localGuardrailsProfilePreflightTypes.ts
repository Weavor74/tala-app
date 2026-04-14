import type { ValidatorProviderKind } from './guardrailPolicyTypes';

export type GuardrailPreflightStatus = 'ready' | 'degraded' | 'blocked';

export interface GuardrailPreflightProviderStatus {
    providerKind: ValidatorProviderKind;
    status: GuardrailPreflightStatus;
    ready: boolean;
    message?: string;
}

export interface GuardrailPreflightBindingProbeStatus {
    attempted: boolean;
    success?: boolean;
    passed?: boolean;
    error?: string;
}

export interface GuardrailPreflightBindingStatus {
    bindingId: string;
    bindingName: string;
    providerKind: ValidatorProviderKind;
    ruleId: string;
    ruleName: string;
    failOpen: boolean;
    status: GuardrailPreflightStatus;
    message?: string;
    probe: GuardrailPreflightBindingProbeStatus;
}

export interface GuardrailPreflightSummary {
    providersTotal: number;
    providersReady: number;
    providersDegraded: number;
    providersBlocked: number;
    bindingsTotal: number;
    bindingsReady: number;
    bindingsDegraded: number;
    bindingsBlocked: number;
}

export interface GuardrailProfilePreflightResult {
    checkedAt: string;
    profileId: string;
    status: GuardrailPreflightStatus;
    providers: GuardrailPreflightProviderStatus[];
    bindings: GuardrailPreflightBindingStatus[];
    summary: GuardrailPreflightSummary;
    issues: string[];
}

