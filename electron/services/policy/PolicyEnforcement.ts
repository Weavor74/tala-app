import {
    policyGate,
    PolicyDeniedError,
    type PolicyDecision,
    type SideEffectContext,
} from './PolicyGate';
import { TelemetryBus } from '../telemetry/TelemetryBus';

export type GuardrailSubsystem = 'tool' | 'memory' | 'inference' | 'autonomy' | 'workflow';
export type GuardrailDecisionKind = 'allow' | 'warn' | 'deny';

function decisionKindFromPolicyDecision(decision: PolicyDecision): GuardrailDecisionKind {
    if (!decision.allowed) return 'deny';
    if (decision.code === 'POLICY_ALLOW_WITH_WARNINGS') return 'warn';
    return 'allow';
}

function emitGuardrailEnforcementLog(
    subsystem: GuardrailSubsystem,
    ctx: SideEffectContext,
    decision: PolicyDecision,
): void {
    try {
        TelemetryBus.getInstance().emit({
            executionId: ctx.executionId ?? `guardrail-${Date.now()}`,
            subsystem: 'system',
            event: 'policy.guardrail_enforcement',
            phase: 'decision',
            payload: {
                subsystem,
                decision: decisionKindFromPolicyDecision(decision),
                allowed: decision.allowed,
                reason: decision.reason,
                code: decision.code,
                profileId: policyGate.getActiveProfileId(),
                actionKind: ctx.actionKind,
                executionType: ctx.executionType,
                executionOrigin: ctx.executionOrigin,
                executionMode: ctx.executionMode,
                capability: ctx.capability,
                targetSubsystem: ctx.targetSubsystem,
                mutationIntent: ctx.mutationIntent,
            },
        });
    } catch {
        // Telemetry failures must never interrupt enforcement.
    }
}

export async function enforceSideEffectWithGuardrails(
    subsystem: GuardrailSubsystem,
    ctx: SideEffectContext,
    content?: string | Record<string, unknown>,
): Promise<PolicyDecision> {
    const decision = await policyGate.checkSideEffectAsync(ctx, content);
    emitGuardrailEnforcementLog(subsystem, ctx, decision);
    if (!decision.allowed) {
        throw new PolicyDeniedError(decision);
    }
    return decision;
}
