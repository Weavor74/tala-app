import { describe, expect, it } from 'vitest';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    return {
        triggerId: 'trg-1',
        executionId: 'exec-1',
        type: 'execution_failed',
        reasonCode: 'test.reason',
        timestamp: '2026-04-17T00:00:00.000Z',
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

describe('RecoveryPolicyService', () => {
    it('timeout with retries remaining -> retry', () => {
        const engine = new RecoveryPolicyService(() => 'dec-1');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'timeout',
                    message: 'timed out',
                    retryable: true,
                },
            }),
        );
        expect(decision.type).toBe('retry');
        expect(decision.reasonCode).toBe('recovery.retry.timeout');
    });

    it('unavailable with canReplan -> replan', () => {
        const engine = new RecoveryPolicyService(() => 'dec-2');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'unavailable',
                    message: 'provider unavailable',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('replan');
        expect(decision.reasonCode).toBe('recovery.replan.unavailable');
    });

    it('runtime degraded with canReplan -> replan', () => {
        const engine = new RecoveryPolicyService(() => 'dec-3');
        const decision = engine.selectDecision(
            makeTrigger({
                type: 'runtime_degraded',
            }),
        );
        expect(decision.type).toBe('replan');
        expect(decision.reasonCode).toBe('recovery.replan.runtime_degraded');
    });

    it('policy blocked with canEscalate -> escalate', () => {
        const engine = new RecoveryPolicyService(() => 'dec-4');
        const decision = engine.selectDecision(
            makeTrigger({
                failure: {
                    family: 'policy_blocked',
                    message: 'policy denied',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('escalate');
        expect(decision.reasonCode).toBe('recovery.escalate.policy_blocked');
    });

    it('unknown failure/no path -> stop', () => {
        const engine = new RecoveryPolicyService(() => 'dec-5');
        const decision = engine.selectDecision(
            makeTrigger({
                context: {
                    retryCount: 2,
                    maxRetries: 2,
                    replanCount: 0,
                    maxReplans: 2,
                    canReplan: false,
                    canEscalate: false,
                    scope: 'execution_boundary',
                },
                failure: {
                    family: 'unknown',
                    message: 'unknown',
                    retryable: false,
                },
            }),
        );
        expect(decision.type).toBe('stop');
        expect(decision.reasonCode).toBe('recovery.stop.no_valid_path');
    });
});

