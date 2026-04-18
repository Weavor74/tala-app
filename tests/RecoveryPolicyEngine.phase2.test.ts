import { describe, expect, it } from 'vitest';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    return {
        triggerId: 'trg-p2',
        executionId: 'exec-p2',
        executionBoundaryId: 'b-1',
        type: 'workflow_failed',
        reasonCode: 'test.reason',
        timestamp: '2026-04-18T00:00:00.000Z',
        context: {
            retryCount: 0,
            maxRetries: 2,
            replanCount: 0,
            maxReplans: 2,
            canReplan: true,
            canEscalate: true,
            canDegradeContinue: false,
            scope: 'execution_boundary',
        },
        ...overrides,
    };
}

describe('RecoveryPolicyService Phase 2', () => {
    it('dependency degraded + continue allowed -> degrade_and_continue', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-1');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'dependency_degraded',
                    message: 'vector unavailable',
                    retryable: false,
                },
                context: {
                    ...makeTrigger().context,
                    canReplan: false,
                    canDegradeContinue: true,
                    degradedCapability: 'vector_retrieval',
                    degradedModeHint: 'local_only',
                },
            }),
        );
        expect(decision.type).toBe('degrade_and_continue');
        expect(decision.reasonCode).toBe('recovery.degrade.local_only');
    });

    it('capability unavailable + replan allowed -> replan', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-2');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'capability_unavailable',
                    message: 'workflow engine missing',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('replan');
        expect(decision.reasonCode).toBe('recovery.replan.capability_unavailable');
    });

    it('authentication failed + canEscalate -> escalate', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-3');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'authentication_failed',
                    message: 'auth required',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('escalate');
        expect(decision.reasonCode).toBe('recovery.escalate.authentication_failed');
    });

    it('rate limited + retries remaining -> retry', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-4');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'rate_limited',
                    message: '429',
                    retryable: true,
                },
            }),
        );
        expect(decision.type).toBe('retry');
        expect(decision.reasonCode).toBe('recovery.retry.rate_limited');
    });

    it('recovery exhausted -> stop when escalation unavailable', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-5');
        const decision = engine.selectDecision(
            makeTrigger({
                context: {
                    retryCount: 2,
                    maxRetries: 2,
                    replanCount: 2,
                    maxReplans: 2,
                    canReplan: true,
                    canEscalate: false,
                    canDegradeContinue: false,
                    scope: 'execution_boundary',
                },
                failure: {
                    family: 'unavailable',
                    message: 'down',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('stop');
        expect(decision.reasonCode).toBe('recovery.stop.recovery_exhausted');
    });

    it('loop detected -> escalate when allowed', () => {
        const engine = new RecoveryPolicyService(() => 'dec-p2-6');
        const decision = engine.selectDecision(
            makeTrigger({
                context: {
                    ...makeTrigger().context,
                    loopDetected: true,
                    canEscalate: true,
                },
                failure: {
                    family: 'timeout',
                    message: 'timed out',
                    retryable: true,
                },
            }),
        );
        expect(decision.type).toBe('escalate');
        expect(decision.reasonCode).toBe('recovery.escalate.loop_detected');
    });
});
