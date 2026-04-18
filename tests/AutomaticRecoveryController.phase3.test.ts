import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
import { RecoveryHistoryRepositoryService } from '../electron/services/runtime/recovery/RecoveryHistoryRepository';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

let seq = 0;
function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    seq += 1;
    return {
        triggerId: `trg-p3-${seq}`,
        executionId: `exec-p3-${seq}`,
        executionBoundaryId: `boundary-p3-${seq}`,
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

describe('AutomaticRecoveryControlService Phase 3', () => {
    const history = RecoveryHistoryRepositoryService.getInstance();

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        history._resetForTesting();
    });

    it('transitions approval-required decision to pending_operator', async () => {
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-p3-pending'),
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

        const decision = await controller.handleTrigger(makeTrigger());
        expect(decision.operatorState?.approvalState).toBe('pending_operator');
    });

    it('records operator-approved execution with origin operator_approved', async () => {
        const continueExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-p3-approved'),
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
        const approved = await AutomaticRecoveryControlService.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'approve_degraded_continue',
            operatorReasonCode: 'operator.approved',
        });

        expect(approved.origin).toBe('operator_approved');
        expect(continueExecution).toHaveBeenCalledOnce();

        const recent = await history.listRecent(5);
        expect(recent.some((entry) => entry.origin === 'operator_approved' && entry.outcome === 'executed')).toBe(true);
    });

    it('records override-applied force stop with origin operator_override', async () => {
        const stopExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-p3-override'),
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
        const overridden = await AutomaticRecoveryControlService.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'force_stop',
            operatorReasonCode: 'operator.force_stop',
        });

        expect(overridden.origin).toBe('operator_override');
        expect(overridden.type).toBe('stop');
        expect(stopExecution).toHaveBeenCalledOnce();
    });

    it('records history on denied path and action-failed path', async () => {
        const controllerDenied = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-p3-denied'),
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

        const pending = await controllerDenied.handleTrigger(makeTrigger());
        await AutomaticRecoveryControlService.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'deny',
            operatorReasonCode: 'operator.denied',
        });

        const controllerFailed = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-p3-failed'),
            new RecoveryBudgetService(2, 2),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution: vi.fn().mockResolvedValue(undefined),
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution: vi.fn().mockResolvedValue(undefined),
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
                { applyDegradedMode: vi.fn().mockRejectedValue(new Error('degraded_mode_apply_failed')) },
            ),
        );

        const failedPending = await controllerFailed.handleTrigger(makeTrigger());
        await expect(
            AutomaticRecoveryControlService.submitOperatorRecoveryAction({
                executionId: failedPending.executionId,
                executionBoundaryId: failedPending.executionBoundaryId,
                decisionId: failedPending.decisionId,
                action: 'approve_degraded_continue',
                operatorReasonCode: 'operator.approved',
            }),
        ).rejects.toThrow('degraded_mode_apply_failed');

        const recent = await history.listRecent(20);
        expect(recent.some((entry) => entry.outcome === 'denied')).toBe(true);
        expect(recent.some((entry) => entry.outcome === 'failed')).toBe(true);
    });

    it('rejects override path when no pending decision exists', async () => {
        await expect(
            AutomaticRecoveryControlService.submitOperatorRecoveryAction({
                executionId: 'exec-no-pending',
                executionBoundaryId: 'boundary-no-pending',
                action: 'force_stop',
                operatorReasonCode: 'operator.no_pending',
            }),
        ).rejects.toThrow('RECOVERY_OPERATOR_ACTION_NO_PENDING_DECISION');
    });
});
