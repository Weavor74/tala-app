import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
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
            handoffType: 'tool',
            scope: 'execution_boundary',
        },
        ...overrides,
    };
}

describe('AutomaticRecoveryControlService', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    it('evaluates and executes retry', async () => {
        const retryExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-1'),
            new RecoveryBudgetService(2),
            new RecoveryActionExecutor(
                {
                    retryExecution,
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const decision = await controller.handleTrigger(
            makeTrigger({
                failure: { family: 'timeout', message: 'timeout', retryable: true },
            }),
        );

        expect(decision.type).toBe('retry');
        expect(retryExecution).toHaveBeenCalledOnce();
    });

    it('evaluates and executes replan', async () => {
        const requestRecoveryReplan = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-2'),
            new RecoveryBudgetService(2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan },
            ),
        );

        const decision = await controller.handleTrigger(
            makeTrigger({
                failure: { family: 'unavailable', message: 'unavailable', retryable: false },
            }),
        );

        expect(decision.type).toBe('replan');
        expect(requestRecoveryReplan).toHaveBeenCalledOnce();
    });

    it('evaluates and executes escalate', async () => {
        const escalateExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-3'),
            new RecoveryBudgetService(2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution,
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const decision = await controller.handleTrigger(
            makeTrigger({
                failure: { family: 'policy_blocked', message: 'policy denied', retryable: false },
            }),
        );

        expect(decision.type).toBe('escalate');
        expect(escalateExecution).toHaveBeenCalledOnce();
    });

    it('evaluates and executes stop', async () => {
        const stopExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-4'),
            new RecoveryBudgetService(2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution,
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const decision = await controller.handleTrigger(
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
                failure: { family: 'unknown', message: 'unknown', retryable: false },
            }),
        );

        expect(decision.type).toBe('stop');
        expect(stopExecution).toHaveBeenCalledOnce();
    });

    it('increments retry budget for retry only', async () => {
        const budget = new RecoveryBudgetService(2);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-5'),
            budget,
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        await controller.handleTrigger(
            makeTrigger({
                executionId: 'exec-retry',
                failure: { family: 'timeout', message: 'timeout', retryable: true },
            }),
        );
        await controller.handleTrigger(
            makeTrigger({
                executionId: 'exec-stop',
                context: {
                    retryCount: 2,
                    maxRetries: 2,
                    replanCount: 2,
                    maxReplans: 2,
                    canReplan: false,
                    canEscalate: false,
                    scope: 'execution_boundary',
                },
                failure: { family: 'unknown', message: 'unknown', retryable: false },
            }),
        );

        expect(budget.getBudget({ executionId: 'exec-retry' }).retryCount).toBe(1);
        expect(budget.getBudget({ executionId: 'exec-stop' }).retryCount).toBe(0);
    });

    it('emits recovery.action_failed when executor throws', async () => {
        const bus = TelemetryBus.getInstance();
        const emitted: string[] = [];
        bus.subscribe((event) => emitted.push(event.event));

        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-6'),
            new RecoveryBudgetService(2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockRejectedValue(new Error('retry failed')),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
            bus,
        );

        await expect(
            controller.handleTrigger(
                makeTrigger({
                    failure: { family: 'timeout', message: 'timeout', retryable: true },
                }),
            ),
        ).rejects.toThrow('retry failed');

        expect(emitted).toContain('recovery.action_failed');
    });
});


