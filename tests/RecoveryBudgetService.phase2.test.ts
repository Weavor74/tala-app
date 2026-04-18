import { describe, expect, it } from 'vitest';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';

describe('RecoveryBudgetService Phase 2', () => {
    it('tracks retry and replan counters independently', () => {
        const service = new RecoveryBudgetService(2, 3);
        service.incrementRetry({ executionId: 'exec-1' });
        service.incrementReplan({ executionId: 'exec-1' });
        const budget = service.getBudget({ executionId: 'exec-1' });
        expect(budget.retryCount).toBe(1);
        expect(budget.replanCount).toBe(1);
        expect(budget.remainingRetries).toBe(1);
        expect(budget.remainingReplans).toBe(2);
    });

    it('prefers boundary-scoped budget over execution scope when boundary exists', () => {
        const service = new RecoveryBudgetService(2, 2);
        service.incrementRetry({ executionId: 'exec-1', executionBoundaryId: 'b-1' });
        const boundaryBudget = service.getBudget({ executionId: 'exec-1', executionBoundaryId: 'b-1' });
        const executionBudget = service.getBudget({ executionId: 'exec-1' });
        expect(boundaryBudget.retryCount).toBe(1);
        expect(executionBudget.retryCount).toBe(0);
    });

    it('computes exhaustion flags correctly', () => {
        const service = new RecoveryBudgetService(1, 1);
        service.incrementRetry({ executionId: 'exec-1' });
        service.incrementReplan({ executionId: 'exec-1' });
        const exhausted = service.isExhausted({ executionId: 'exec-1' });
        expect(exhausted.retryExhausted).toBe(true);
        expect(exhausted.replanExhausted).toBe(true);
        expect(exhausted.anyExhausted).toBe(true);
    });

    it('detects loop when retry/replan alternation threshold is exceeded', () => {
        const service = new RecoveryBudgetService(5, 5, 6, 10);
        const input = { executionId: 'exec-1', executionBoundaryId: 'b-1' as const };
        service.recordDecision(input, 'retry', 'recovery.retry.timeout');
        service.recordDecision(input, 'replan', 'recovery.replan.unavailable');
        service.recordDecision(input, 'retry', 'recovery.retry.timeout');
        service.recordDecision(input, 'replan', 'recovery.replan.unavailable');
        service.recordDecision(input, 'retry', 'recovery.retry.timeout');
        const loop = service.recordDecision(input, 'replan', 'recovery.replan.unavailable');
        expect(loop.loopDetected).toBe(true);
        expect(loop.reasonCode).toBe('recovery.loop.alternating_cycle');
    });

    it('reset clears counters and loop state', () => {
        const service = new RecoveryBudgetService(2, 2, 4, 2);
        const input = { executionId: 'exec-1' };
        service.incrementRetry(input);
        service.recordDecision(input, 'retry', 'recovery.retry.timeout');
        service.recordDecision(input, 'retry', 'recovery.retry.timeout');
        expect(service.getBudget(input).loopDetected).toBe(true);
        service.reset(input);
        const reset = service.getBudget(input);
        expect(reset.retryCount).toBe(0);
        expect(reset.replanCount).toBe(0);
        expect(reset.loopDetected).toBe(false);
    });
});
