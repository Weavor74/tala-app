import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { PlanningHandoffCoordinator } from '../electron/services/planning/PlanningHandoffCoordinator';
import { WorkflowHandoffCoordinator } from '../electron/services/planning/WorkflowHandoffCoordinator';

describe('AutomaticRecovery integration', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('tool failure routes into recovery controller and produces action telemetry', async () => {
        const fakePlan = {
            id: 'plan-tool-1',
            goalId: 'goal-tool-1',
            handoff: {
                type: 'tool',
                sharedInputs: {},
                steps: [
                    {
                        toolId: 'tool.fail',
                        input: {},
                        failurePolicy: 'stop',
                    },
                ],
            },
        };
        const planningMock = {
            getPlan: vi.fn().mockReturnValue(fakePlan),
            markExecutionStarted: vi.fn().mockReturnValue({
                ...fakePlan,
                executionBoundaryId: 'exec-boundary-tool-1',
            }),
            markExecutionFailed: vi.fn(),
            markExecutionCompleted: vi.fn(),
            replan: vi.fn(),
        };
        vi.spyOn(PlanningService, 'getInstance').mockReturnValue(planningMock as any);

        const events: string[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event.event));

        const coordinator = new PlanningHandoffCoordinator({
            executeTool: vi.fn().mockResolvedValue({
                success: false,
                error: 'dependency unreachable',
            }),
        });

        const result = await coordinator.dispatch('plan-tool-1', {
            turnId: 'turn-1',
            mode: 'goal_execution',
            authorityLevel: 'full_authority',
            workflowAuthority: true,
            canCreateDurableState: true,
            canReplan: true,
        });

        expect(result.success).toBe(false);
        expect(result.recoveryOutcome).toBe('replan_required');
        expect(events).toContain('recovery.triggered');
        expect(events).toContain('recovery.decision_made');
        expect(events).toContain('recovery.action_executed');
    });

    it('runtime degraded preflight routes into replan decision without duplicate handling', async () => {
        const fakePlan = {
            id: 'plan-wf-1',
            goalId: 'goal-wf-1',
            planningInvocation: undefined,
            handoff: {
                type: 'workflow',
                sharedInputs: {},
                invocations: [
                    {
                        workflowId: 'wf-a',
                        input: {},
                        requiredCapabilities: ['workflow_engine'],
                        failurePolicy: 'stop',
                    },
                ],
            },
        };
        const planningMock = {
            getPlan: vi.fn().mockReturnValue(fakePlan),
            markExecutionStarted: vi.fn().mockReturnValue({
                ...fakePlan,
                executionBoundaryId: 'exec-boundary-wf-1',
            }),
            markExecutionFailed: vi.fn(),
            markExecutionCompleted: vi.fn(),
            replan: vi.fn().mockReturnValue({ id: 'plan-wf-2' }),
        };
        vi.spyOn(PlanningService, 'getInstance').mockReturnValue(planningMock as any);

        const decisionEvents: any[] = [];
        TelemetryBus.getInstance().subscribe((event) => {
            if (event.event === 'recovery.decision_made') {
                decisionEvents.push(event);
            }
        });

        const coordinator = new WorkflowHandoffCoordinator({
            executeWorkflow: vi.fn().mockResolvedValue({ success: true }),
        });

        const result = await coordinator.dispatch(
            'plan-wf-1',
            new Set(),
            {
                turnId: 'turn-2',
                mode: 'goal_execution',
                authorityLevel: 'full_authority',
                workflowAuthority: true,
                canCreateDurableState: true,
                canReplan: true,
            },
        );

        expect(result.success).toBe(false);
        expect(result.replanAdvised).toBe(true);
        expect(decisionEvents).toHaveLength(1);
        expect(decisionEvents[0].payload?.decisionType).toBe('replan');
        expect(planningMock.replan).toHaveBeenCalledTimes(1);
    });
});

