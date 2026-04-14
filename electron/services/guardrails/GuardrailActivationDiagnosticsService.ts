import {
    type GuardrailPolicyConfig,
    normalizeGuardrailPolicyConfig,
} from '../../../shared/guardrails/guardrailPolicyTypes';
import {
    evaluateGuardrailProfileActivationSafety,
    type GuardrailActivationSafetyDecision,
} from '../../../shared/guardrails/guardrailActivationSafety';
import type { GuardrailProfilePreflightResult } from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';
import {
    localGuardrailsProfilePreflightService,
    type LocalGuardrailsProfilePreflightService,
} from './LocalGuardrailsProfilePreflightService';
import { guardrailsTelemetry, type IGuardrailsTelemetry } from './GuardrailsTelemetry';

export interface GuardrailActivationDiagnosticsResult {
    profileId: string;
    preflight: GuardrailProfilePreflightResult;
    decision: GuardrailActivationSafetyDecision;
    decisionKind: 'allow' | 'warn' | 'deny';
}

interface GuardrailActivationDiagnosticsDeps {
    preflightService?: Pick<LocalGuardrailsProfilePreflightService, 'runProfilePreflight'>;
    telemetry?: IGuardrailsTelemetry;
}

export class GuardrailActivationDiagnosticsService {
    private readonly _preflightService: Pick<LocalGuardrailsProfilePreflightService, 'runProfilePreflight'>;
    private readonly _telemetry: IGuardrailsTelemetry;

    constructor(deps: GuardrailActivationDiagnosticsDeps = {}) {
        this._preflightService = deps.preflightService ?? localGuardrailsProfilePreflightService;
        this._telemetry = deps.telemetry ?? guardrailsTelemetry;
    }

    async evaluateActivation(input: {
        policy: GuardrailPolicyConfig;
        profileId: string;
    }): Promise<GuardrailActivationDiagnosticsResult> {
        const startedAt = Date.now();
        const policy = normalizeGuardrailPolicyConfig(input.policy);
        const preflight = await this._preflightService.runProfilePreflight({
            policy,
            profileId: input.profileId,
            runProbe: true,
        });
        const decision = evaluateGuardrailProfileActivationSafety(preflight);
        const decisionKind: 'allow' | 'warn' | 'deny' = !decision.allowActivation
            ? 'deny'
            : decision.warnUser
                ? 'warn'
                : 'allow';
        const firstFixHint =
            preflight.bindings.find(binding => Boolean(binding.fixHint))?.fixHint
            ?? preflight.providers.find(provider => Boolean(provider.fixHint))?.fixHint;

        this._telemetry.emit({
            eventName: 'guardrails.activation',
            actor: 'GuardrailActivationDiagnosticsService',
            summary: decision.message,
            status: preflight.status === 'ready' ? 'passed' : preflight.status,
            decision: decisionKind,
            payload: {
                profileId: input.profileId,
                reason: preflight.issues[0] ?? decision.message,
                code: decisionKind === 'deny'
                    ? 'ACTIVATION_BLOCKED'
                    : decisionKind === 'warn'
                        ? 'ACTIVATION_WARNED'
                        : 'ACTIVATION_ALLOWED',
                fixHint: firstFixHint,
                durationMs: Date.now() - startedAt,
                preflightStatus: preflight.status,
                preflightSummary: preflight.summary,
            },
        });

        return {
            profileId: input.profileId,
            preflight,
            decision,
            decisionKind,
        };
    }
}

export const guardrailActivationDiagnosticsService = new GuardrailActivationDiagnosticsService();
