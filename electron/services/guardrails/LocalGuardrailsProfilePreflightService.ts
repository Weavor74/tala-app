import type {
    GuardrailPolicyConfig,
    GuardrailProfile,
    GuardrailRule,
    ValidatorBinding,
    ValidatorProviderKind,
} from '../../../shared/guardrails/guardrailPolicyTypes';
import { normalizeGuardrailPolicyConfig } from '../../../shared/guardrails/guardrailPolicyTypes';
import type { GuardrailValidationResult } from './types';
import type {
    GuardrailPreflightBindingStatus,
    GuardrailPreflightProviderStatus,
    GuardrailProfilePreflightResult,
} from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';
import { localGuardrailsRuntimeHealth, type LocalGuardrailsRuntimeHealth } from './LocalGuardrailsRuntimeHealth';
import {
    localGuardrailsBindingProbeService,
    type LocalGuardrailsBindingProbeService,
} from './LocalGuardrailsBindingProbeService';

interface LocalGuardrailsProfilePreflightInput {
    policy: GuardrailPolicyConfig;
    profileId: string;
    runProbe?: boolean;
    sampleContent?: string;
}

interface LocalGuardrailsProfilePreflightDeps {
    runtimeHealth?: Pick<LocalGuardrailsRuntimeHealth, 'checkReadiness'>;
    probeService?: Pick<LocalGuardrailsBindingProbeService, 'testBinding'>;
}

const REMOTE_PROVIDER_PREFIX = 'remote_';

export class LocalGuardrailsProfilePreflightService {
    private readonly _runtimeHealth: Pick<LocalGuardrailsRuntimeHealth, 'checkReadiness'>;
    private readonly _probeService: Pick<LocalGuardrailsBindingProbeService, 'testBinding'>;

    constructor(deps: LocalGuardrailsProfilePreflightDeps = {}) {
        this._runtimeHealth = deps.runtimeHealth ?? localGuardrailsRuntimeHealth;
        this._probeService = deps.probeService ?? localGuardrailsBindingProbeService;
    }

    async runProfilePreflight(
        input: LocalGuardrailsProfilePreflightInput,
    ): Promise<GuardrailProfilePreflightResult> {
        const checkedAt = new Date().toISOString();
        const policy = normalizeGuardrailPolicyConfig(input.policy);
        const profile = policy.profiles.find(p => p.id === input.profileId);
        if (!profile) {
            return this._finalize(checkedAt, input.profileId, [], [], [
                `Profile '${input.profileId}' was not found`,
            ]);
        }

        const rules = this._resolveProfileRules(policy, profile);
        const bindings = this._resolveProfileBindings(rules);
        if (bindings.length === 0) {
            return this._finalize(checkedAt, profile.id, [], [], []);
        }

        const providers = await this._evaluateProviders(bindings);
        const providerMap = new Map(providers.map(p => [p.providerKind, p]));
        const bindingStatuses: GuardrailPreflightBindingStatus[] = [];

        for (const { rule, binding } of bindings) {
            const provider = providerMap.get(binding.providerKind)!;
            bindingStatuses.push(await this._evaluateBinding({
                provider,
                binding,
                rule,
                runProbe: input.runProbe ?? true,
                sampleContent: input.sampleContent ?? 'Preflight probe content',
            }));
        }

        const issues: string[] = [
            ...providers.filter(p => p.status !== 'ready').map(p => p.message).filter(Boolean) as string[],
            ...bindingStatuses.filter(b => b.status !== 'ready').map(b => b.message).filter(Boolean) as string[],
        ];

        return this._finalize(checkedAt, profile.id, providers, bindingStatuses, issues);
    }

    private _resolveProfileRules(
        policy: GuardrailPolicyConfig,
        profile: GuardrailProfile,
    ): GuardrailRule[] {
        const byId = new Map(policy.rules.map(rule => [rule.id, rule]));
        return profile.ruleIds
            .map(ruleId => byId.get(ruleId))
            .filter((rule): rule is GuardrailRule => Boolean(rule));
    }

    private _resolveProfileBindings(
        rules: GuardrailRule[],
    ): Array<{ rule: GuardrailRule; binding: ValidatorBinding }> {
        const resolved: Array<{ rule: GuardrailRule; binding: ValidatorBinding }> = [];
        for (const rule of rules) {
            for (const binding of rule.validatorBindings ?? []) {
                if (!binding.enabled) continue;
                resolved.push({ rule, binding });
            }
        }
        return resolved;
    }

    private async _evaluateProviders(
        bindings: Array<{ rule: GuardrailRule; binding: ValidatorBinding }>,
    ): Promise<GuardrailPreflightProviderStatus[]> {
        const kinds = [...new Set(bindings.map(item => item.binding.providerKind))];
        const providers: GuardrailPreflightProviderStatus[] = [];

        for (const providerKind of kinds) {
            providers.push(await this._evaluateProvider(providerKind));
        }

        return providers;
    }

    private async _evaluateProvider(
        providerKind: ValidatorProviderKind,
    ): Promise<GuardrailPreflightProviderStatus> {
        if (providerKind === 'local_guardrails_ai') {
            const readiness = await this._runtimeHealth.checkReadiness();
            if (readiness.ready) {
                return {
                    providerKind,
                    status: 'ready',
                    ready: true,
                };
            }
            return {
                providerKind,
                status: 'degraded',
                ready: false,
                message: readiness.guardrails.error ?? readiness.python.error ?? 'local_guardrails_ai runtime not ready',
            };
        }

        if (providerKind.startsWith(REMOTE_PROVIDER_PREFIX)) {
            return {
                providerKind,
                status: 'blocked',
                ready: false,
                message: `Provider '${providerKind}' is remote; local-only preflight cannot validate remote runtimes`,
            };
        }

        return {
            providerKind,
            status: 'degraded',
            ready: false,
            message: `Provider '${providerKind}' has no local preflight health checker yet`,
        };
    }

    private async _evaluateBinding(input: {
        provider: GuardrailPreflightProviderStatus;
        binding: ValidatorBinding;
        rule: GuardrailRule;
        runProbe: boolean;
        sampleContent: string;
    }): Promise<GuardrailPreflightBindingStatus> {
        const { provider, binding, rule, runProbe, sampleContent } = input;
        const base: GuardrailPreflightBindingStatus = {
            bindingId: binding.id,
            bindingName: binding.name,
            providerKind: binding.providerKind,
            ruleId: rule.id,
            ruleName: rule.name,
            failOpen: binding.failOpen,
            status: 'ready',
            probe: { attempted: false },
        };

        if (!provider.ready) {
            return {
                ...base,
                status: binding.failOpen ? 'degraded' : 'blocked',
                message: provider.message ?? `Provider '${provider.providerKind}' is not ready`,
            };
        }

        if (binding.providerKind !== 'local_guardrails_ai' || !runProbe) {
            return base;
        }

        const probeResult = await this._probeService.testBinding({
            binding,
            sampleContent,
        });

        return this._bindingFromProbe(base, probeResult);
    }

    private _bindingFromProbe(
        base: GuardrailPreflightBindingStatus,
        probeResult: GuardrailValidationResult,
    ): GuardrailPreflightBindingStatus {
        if (probeResult.success) {
            return {
                ...base,
                status: 'ready',
                probe: {
                    attempted: true,
                    success: true,
                    passed: probeResult.passed,
                },
            };
        }

        const failOpen = base.failOpen;
        return {
            ...base,
            status: failOpen ? 'degraded' : 'blocked',
            message: probeResult.error ?? 'Probe failed',
            probe: {
                attempted: true,
                success: false,
                error: probeResult.error ?? 'Probe failed',
            },
        };
    }

    private _finalize(
        checkedAt: string,
        profileId: string,
        providers: GuardrailPreflightProviderStatus[],
        bindings: GuardrailPreflightBindingStatus[],
        issues: string[],
    ): GuardrailProfilePreflightResult {
        const summary = {
            providersTotal: providers.length,
            providersReady: providers.filter(p => p.status === 'ready').length,
            providersDegraded: providers.filter(p => p.status === 'degraded').length,
            providersBlocked: providers.filter(p => p.status === 'blocked').length,
            bindingsTotal: bindings.length,
            bindingsReady: bindings.filter(b => b.status === 'ready').length,
            bindingsDegraded: bindings.filter(b => b.status === 'degraded').length,
            bindingsBlocked: bindings.filter(b => b.status === 'blocked').length,
        };

        const status =
            summary.bindingsBlocked > 0
                ? 'blocked'
                : (summary.bindingsDegraded > 0 || summary.providersBlocked > 0 || summary.providersDegraded > 0)
                    ? 'degraded'
                    : 'ready';

        return {
            checkedAt,
            profileId,
            status,
            providers,
            bindings,
            summary,
            issues,
        };
    }
}

export const localGuardrailsProfilePreflightService = new LocalGuardrailsProfilePreflightService();

