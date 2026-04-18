import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceDiagnosticsService } from '../electron/services/InferenceDiagnosticsService';
import { RuntimeDiagnosticsAggregator } from '../electron/services/RuntimeDiagnosticsAggregator';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
import { RecoveryHistoryRepositoryService } from '../electron/services/runtime/recovery/RecoveryHistoryRepository';
import { RecoveryOperatorControlService } from '../electron/services/runtime/recovery/RecoveryOperatorControlService';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeMcpLifecycle() {
    return {
        getDiagnosticsInventory: () => ({
            services: [],
            totalConfigured: 0,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: '2026-04-18T00:00:00.000Z',
        }),
    };
}

let seq = 0;
function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    seq += 1;
    return {
        triggerId: `trg-int-p3-${seq}`,
        executionId: `exec-int-p3-${seq}`,
        executionBoundaryId: `boundary-int-p3-${seq}`,
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

describe('Recovery Phase 3 integration', () => {
    const history = RecoveryHistoryRepositoryService.getInstance();

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        history._resetForTesting();
    });

    it('projects pending recovery state into runtime diagnostics snapshot', async () => {
        const diagnostics = new RuntimeDiagnosticsAggregator(new InferenceDiagnosticsService(), makeMcpLifecycle() as any);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-int-p3-pending'),
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
        const recovery = diagnostics.getSnapshot().recovery;

        expect(decision.operatorState?.approvalState).toBe('pending_operator');
        expect(recovery?.activeDecision?.approvalState).toBe('pending_operator');
        expect(recovery?.counters.approvalsRequired).toBeGreaterThanOrEqual(1);
    });

    it('routes operator approval through controller and updates history/analytics', async () => {
        const diagnostics = new RuntimeDiagnosticsAggregator(new InferenceDiagnosticsService(), makeMcpLifecycle() as any);
        const continueExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-int-p3-approve'),
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
        const operatorControl = new RecoveryOperatorControlService();
        await operatorControl.submitOperatorRecoveryAction({
            executionId: pending.executionId,
            executionBoundaryId: pending.executionBoundaryId,
            decisionId: pending.decisionId,
            action: 'approve_degraded_continue',
            operatorReasonCode: 'operator.integration_approved',
        });

        const recovery = diagnostics.getSnapshot().recovery;
        expect(continueExecution).toHaveBeenCalledOnce();
        expect(recovery?.recentHistory.length).toBeGreaterThan(0);
        expect(recovery?.analytics.totals.degradedContinues).toBeGreaterThan(0);
    });

    it('keeps automatic retry behavior unchanged when operator action is not required', async () => {
        const retryExecution = vi.fn().mockResolvedValue(undefined);
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-int-p3-retry'),
            new RecoveryBudgetService(2, 2),
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
                type: 'tool_failed',
                context: {
                    handoffType: 'tool',
                    canReplan: true,
                    canEscalate: true,
                    canDegradeContinue: false,
                    scope: 'execution_boundary',
                    retryCount: 0,
                    maxRetries: 2,
                    replanCount: 0,
                    maxReplans: 2,
                },
                failure: {
                    family: 'timeout',
                    message: 'timed out',
                    retryable: true,
                },
            }),
        );

        expect(decision.type).toBe('retry');
        expect(decision.operatorState?.approvalState).toBe('not_required');
        expect(retryExecution).toHaveBeenCalledOnce();
    });
});
