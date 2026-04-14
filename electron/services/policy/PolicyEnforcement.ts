import {
    policyGate,
    PolicyDeniedError,
    type PolicyDecision,
    type SideEffectContext,
} from './PolicyGate';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { guardrailsTelemetry } from '../guardrails/GuardrailsTelemetry';

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
    const decisionKind = decisionKindFromPolicyDecision(decision);
    try {
        TelemetryBus.getInstance().emit({
            executionId: ctx.executionId ?? `guardrail-${Date.now()}`,
            subsystem: 'system',
            event: 'policy.guardrail_enforcement',
            phase: 'decision',
            payload: {
                subsystem,
                decision: decisionKind,
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

    try {
        guardrailsTelemetry.emit({
            eventName: 'guardrails.enforcement',
            actor: 'PolicyEnforcement',
            summary: `Guardrail enforcement decision '${decisionKind}' for subsystem '${subsystem}'.`,
            status: decisionKind === 'deny' ? 'blocked' : 'passed',
            decision: decisionKind,
            payload: {
                profileId: policyGate.getActiveProfileId(),
                reason: decision.reason,
                code: decision.code,
                executionId: ctx.executionId,
                executionType: ctx.executionType,
                executionOrigin: ctx.executionOrigin,
                executionMode: ctx.executionMode,
                targetSubsystem: ctx.targetSubsystem,
                actionKind: ctx.actionKind,
                capability: ctx.capability,
                mutationIntent: ctx.mutationIntent,
                subsystemTarget: subsystem,
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
