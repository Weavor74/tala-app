import { describe, expect, it, vi } from 'vitest';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import type { RecoveryDecision, RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeTrigger(): RecoveryTrigger {
    return {
        triggerId: 'trg-x',
        executionId: 'exec-x',
        executionBoundaryId: 'b-x',
        type: 'runtime_degraded',
        reasonCode: 'runtime.degraded',
        timestamp: '2026-04-18T00:00:00.000Z',
        context: {},
    };
}

function makeDecision(type: RecoveryDecision['type']): RecoveryDecision {
    return {
        decisionId: `dec-${type}`,
        triggerId: 'trg-x',
        executionId: 'exec-x',
        executionBoundaryId: 'b-x',
        type,
        reasonCode: `reason.${type}`,
    };
}

describe('RecoveryActionExecutor Phase 2', () => {
    it('degrade_and_continue routes through degraded mode port then continue seam', async () => {
        const order: string[] = [];
        const executor = new RecoveryActionExecutor(
            {
                retryExecution: vi.fn(async () => { order.push('retry'); }),
                escalateExecution: vi.fn(async () => { order.push('escalate'); }),
                continueExecution: vi.fn(async () => { order.push('continue'); }),
                stopExecution: vi.fn(async () => { order.push('stop'); }),
            },
            {
                requestRecoveryReplan: vi.fn(async () => { order.push('replan'); }),
            },
            {
                applyDegradedMode: vi.fn(async () => { order.push('degraded_mode'); }),
            },
        );

        const decision: RecoveryDecision = {
            ...makeDecision('degrade_and_continue'),
            degradedMode: {
                disabledCapabilities: ['web_fetch'],
                continueMode: 'local_only',
            },
        };

        await executor.executeDecision(decision, makeTrigger());
        expect(order).toEqual(['degraded_mode', 'continue']);
    });

    it('retry/replan/escalate/stop route only through their ports', async () => {
        const retryExecution = vi.fn().mockResolvedValue(undefined);
        const requestRecoveryReplan = vi.fn().mockResolvedValue(undefined);
        const escalateExecution = vi.fn().mockResolvedValue(undefined);
        const stopExecution = vi.fn().mockResolvedValue(undefined);
        const continueExecution = vi.fn().mockResolvedValue(undefined);
        const applyDegradedMode = vi.fn().mockResolvedValue(undefined);

        const executor = new RecoveryActionExecutor(
            {
                retryExecution,
                escalateExecution,
                continueExecution,
                stopExecution,
            },
            { requestRecoveryReplan },
            { applyDegradedMode },
        );

        await executor.executeDecision(makeDecision('retry'), makeTrigger());
        await executor.executeDecision(makeDecision('replan'), makeTrigger());
        await executor.executeDecision(makeDecision('escalate'), makeTrigger());
        await executor.executeDecision(makeDecision('stop'), makeTrigger());

        expect(retryExecution).toHaveBeenCalledTimes(1);
        expect(requestRecoveryReplan).toHaveBeenCalledTimes(1);
        expect(escalateExecution).toHaveBeenCalledTimes(1);
        expect(stopExecution).toHaveBeenCalledTimes(1);
        expect(continueExecution).toHaveBeenCalledTimes(0);
        expect(applyDegradedMode).toHaveBeenCalledTimes(0);
    });
});
