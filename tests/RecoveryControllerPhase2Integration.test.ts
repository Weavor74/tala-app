import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { WorkflowHandoffCoordinator } from '../electron/services/planning/WorkflowHandoffCoordinator';
import { AutomaticRecoveryControlService } from '../electron/services/runtime/recovery/AutomaticRecoveryController';
import { RecoveryActionExecutor } from '../electron/services/runtime/recovery/RecoveryActionExecutor';
import { RecoveryBudgetService } from '../electron/services/runtime/recovery/RecoveryBudgetService';
import { RecoveryPolicyService } from '../electron/services/runtime/recovery/RecoveryPolicyEngine';
import type { RecoveryTrigger } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeTrigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
    return {
        triggerId: 'trg-int-1',
        executionId: 'exec-int-1',
        executionBoundaryId: 'boundary-int-1',
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
            handoffType: 'workflow',
        },
        ...overrides,
    };
}

describe('AutomaticRecovery Phase 2 integration/regression', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('runtime degraded signal can produce degrade_and_continue when allowed', async () => {
        const fakePlan = {
            id: 'plan-wf-degrade-1',
            goalId: 'goal-wf-degrade-1',
            planningInvocation: undefined,
            handoff: {
                type: 'workflow',
                sharedInputs: {},
                invocations: [
                    {
                        workflowId: 'wf-optional',
                        input: {},
                        requiredCapabilities: ['workflow_engine'],
                        failurePolicy: 'skip',
                        degradeAllowed: true,
                    },
                ],
            },
        };
        const planningMock = {
            getPlan: vi.fn().mockReturnValue(fakePlan),
            markExecutionStarted: vi.fn().mockReturnValue({
                ...fakePlan,
                executionBoundaryId: 'exec-boundary-wf-degrade-1',
            }),
            markExecutionFailed: vi.fn(),
            markExecutionCompleted: vi.fn(),
            replan: vi.fn().mockReturnValue({ id: 'plan-wf-degrade-2' }),
        };
        vi.spyOn(PlanningService, 'getInstance').mockReturnValue(planningMock as any);

        const events: string[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event.event));

        const coordinator = new WorkflowHandoffCoordinator({
            executeWorkflow: vi.fn().mockResolvedValue({ success: true }),
        });

        const result = await coordinator.dispatch(
            'plan-wf-degrade-1',
            new Set(),
            {
                turnId: 'turn-degrade-1',
                mode: 'goal_execution',
                authorityLevel: 'full_authority',
                workflowAuthority: true,
                canCreateDurableState: true,
                canReplan: true,
            },
        );

        expect(result.success).toBe(true);
        expect(events).toContain('recovery.degraded_continue_applied');
        expect(planningMock.markExecutionCompleted).toHaveBeenCalledTimes(1);
    });

    it('repeated retry/replan cycling on same boundary is cut off deterministically', async () => {
        const stopExecution = vi.fn().mockResolvedValue(undefined);
        const escalateExecution = vi.fn().mockResolvedValue(undefined);
        let decisionSeq = 0;
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => {
                decisionSeq += 1;
                return `dec-int-${decisionSeq}`;
            }),
            new RecoveryBudgetService(10, 10, 4, 10),
            new RecoveryActionExecutor(
                {
                    retryExecution: vi.fn().mockResolvedValue(undefined),
                    escalateExecution,
                    continueExecution: vi.fn().mockResolvedValue(undefined),
                    stopExecution,
                },
                { requestRecoveryReplan: vi.fn().mockResolvedValue(undefined) },
            ),
        );

        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't1', retryable: true } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'unavailable', message: 'u1', retryable: false } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't2', retryable: true } }),
        );
        await controller.handleTrigger(
            makeTrigger({ failure: { family: 'unavailable', message: 'u2', retryable: false } }),
        );
        const decision = await controller.handleTrigger(
            makeTrigger({ failure: { family: 'timeout', message: 't3', retryable: true } }),
        );

        expect(['escalate', 'stop']).toContain(decision.type);
        expect(escalateExecution.mock.calls.length + stopExecution.mock.calls.length).toBeGreaterThan(0);
    });

    it('boundary-scoped recovery budgets do not spill across boundaries', async () => {
        const controller = new AutomaticRecoveryControlService(
            new RecoveryPolicyService(() => 'dec-boundary'),
            new RecoveryBudgetService(2, 2),
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
                executionBoundaryId: 'boundary-a',
                failure: { family: 'rate_limited', message: '429', retryable: true },
            }),
        );

        const decisionBoundaryB = await controller.handleTrigger(
            makeTrigger({
                executionBoundaryId: 'boundary-b',
                failure: { family: 'rate_limited', message: '429', retryable: true },
            }),
        );

        expect(decisionBoundaryB.type).toBe('retry');
    });
});
