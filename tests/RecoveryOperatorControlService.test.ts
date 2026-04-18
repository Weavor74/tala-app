import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
import { RecoveryHistoryRepositoryService } from '../electron/services/runtime/recovery/RecoveryHistoryRepository';
import { RecoveryOperatorControlService } from '../electron/services/runtime/recovery/RecoveryOperatorControlService';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

let seq = 0;
function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    seq += 1;
    return {
        triggerId: `trg-op-${seq}`,
        executionId: `exec-op-${seq}`,
        executionBoundaryId: `boundary-op-${seq}`,
        type: 'runtime_degraded',
        reasonCode: 'runtime.degraded.capability',
        timestamp: '2026-04-18T00:00:00.000Z',
        context: {
            handoffType: 'workflow',
            canReplan: false,
            canEscalate: true,
            canDegradeContinue: true,
            degradedCapability: 'web_retrieval',
            degradedModeHint: 'local_only',
            scope: 'execution_boundary',
            retryCount: 0,
            maxRetries: 2,
            replanCount: 0,
            maxReplans: 2,
        },
        ...overrides,
    };
}

describe('RecoveryOperatorControlService', () => {
    const history = RecoveryHistoryRepositoryService.getInstance();

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        history._resetForTesting();
    });

    it('routes valid operator approval through recovery controller authority path', async () => {
        const continueExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-op-approve'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution,
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const pending = await controller.handleTrigger(makeTrigger());
        expect(pending.operatorState?.approvalState).toBe('pending_operator');

        const service = new RecoveryOperatorControlService();
        const result = await service.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'approve_degraded_continue',
            operatorReasonCode: 'operator.approved.degraded_continue',
        });

        expect(result.origin).toBe('operator_approved');
        expect(continueExecution).toHaveBeenCalledOnce();
    });

    it('force stop is executed and recorded as override', async () => {
        const stopExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-op-stop'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution,
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const pending = await controller.handleTrigger(makeTrigger());
        const service = new RecoveryOperatorControlService();
        const result = await service.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'force_stop',
            operatorReasonCode: 'operator.force_stop',
        });

        expect(result.type).toBe('stop');
        expect(result.origin).toBe('operator_override');
        expect(stopExecution).toHaveBeenCalledOnce();
    });

    it('deny marks approval denied and records denial history', async () => {
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-op-deny'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const pending = await controller.handleTrigger(makeTrigger());
        const service = new RecoveryOperatorControlService();
        const result = await service.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'deny',
            operatorReasonCode: 'operator.denied',
        });

        expect(result.operatorState?.approvalState).toBe('denied');
        const recent = await history.listRecent(5);
        expect(recent[0]?.outcome).toBe('denied');
    });

    it('rejects invalid operator action for pending decision deterministically', async () => {
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-op-invalid'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        const pending = await controller.handleTrigger(makeTrigger());
        const service = new RecoveryOperatorControlService();

        await expect(
            service.submitOperatorRecoveryAction({
                executionId: pending.executionId,
                executionBoundaryId: pending.executionBoundaryId,
                decisionId: pending.decisionId,
                action: 'approve_retry',
                operatorReasonCode: 'operator.invalid_action',
            }),
        ).rejects.toThrow('RECOVERY_OPERATOR_ACTION_INVALID_FOR_DECISION');
    });
});
