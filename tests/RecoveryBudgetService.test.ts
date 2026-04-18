import { describe, expect, it } from 'vitest';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';

describe('RecoveryBudgetService', () => {
    it('returns initial budget snapshot', () => {
        const service = new RecoveryBudgetService(2, 2);
        expect(service.getBudget({ executionId: 'exec-1' })).toEqual({
            retryCount: 0,
            maxRetries: 2,
            replanCount: 0,
            maxReplans: 2,
            remainingRetries: 2,
            remainingReplans: 2,
            scope: 'execution',
            loopDetected: false,
        });
    });

    it('increments retry count', () => {
        const service = new RecoveryBudgetService(2, 2);
        service.incrementRetry({ executionId: 'exec-1' });
        expect(service.getBudget({ executionId: 'exec-1' }).retryCount).toBe(1);
    });

    it('computes remaining retries', () => {
        const service = new RecoveryBudgetService(2, 2);
        service.incrementRetry({ executionId: 'exec-1' });
        service.incrementRetry({ executionId: 'exec-1' });
        expect(service.getBudget({ executionId: 'exec-1' }).remainingRetries).toBe(0);
    });

    it('resets retry budget', () => {
        const service = new RecoveryBudgetService(2, 2);
        service.incrementRetry({ executionId: 'exec-1' });
        service.reset({ executionId: 'exec-1' });
        expect(service.getBudget({ executionId: 'exec-1' })).toEqual({
            retryCount: 0,
            maxRetries: 2,
            replanCount: 0,
            maxReplans: 2,
            remainingRetries: 2,
            remainingReplans: 2,
            scope: 'execution',
            loopDetected: false,
        });
    });
});

