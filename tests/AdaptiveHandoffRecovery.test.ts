import { beforeEach, describe, expect, it, vi } from 'vitest';

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) => emittedEvents.push(e as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

import { PlanningService } from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';
import {
    WorkflowHandoffCoordinator,
    type IWorkflowExecutor,
} from '../electron/services/planning/WorkflowHandoffCoordinator';
import {
    AgentHandoffCoordinator,
    type IAgentExecutor,
} from '../electron/services/planning/AgentHandoffCoordinator';
import { FailureSuppressionService } from '../electron/services/runtime/failures/FailureRecoveryPolicy';
import { PolicyDeniedError } from '../electron/services/policy/PolicyGate';

function freshPlanning(caps: string[]): { svc: PlanningService; repo: PlanningRepository } {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const svc = PlanningService.getInstance();
    svc.setAvailableCapabilities(new Set(caps));
    return { svc, repo };
}

function createWorkflowPlan(): { svc: PlanningService; repo: PlanningRepository; planId: string } {
    const { svc, repo } = freshPlanning(['workflow_engine']);
    const goal = svc.registerGoal({
        title: 'Adaptive workflow test',
        description: 'Run workflow path',
        source: 'system',
        category: 'workflow',
    });
    const plan = svc.buildPlan(goal.id);
    return { svc, repo, planId: plan.id };
}

function createAgentPlan(): { svc: PlanningService; repo: PlanningRepository; planId: string } {
    const { svc, repo } = freshPlanning(['inference', 'rag']);
    const goal = svc.registerGoal({
        title: 'Adaptive agent test',
        description: 'Run agent path',
        source: 'user',
        category: 'conversation',
    });
    const plan = svc.buildPlan(goal.id);
    return { svc, repo, planId: plan.id };
}

describe('Adaptive recovery at handoff boundaries', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('workflow timeout with retry policy recovers by retry', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'retry' as const,
                })),
            },
        });

        let calls = 0;
        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockImplementation(async () => {
                calls += 1;
                if (calls === 1) return { success: false, error: 'timeout while opening stream' };
                return { success: true, data: { ok: true } };
            }),
        };

        const result = await new WorkflowHandoffCoordinator(executor).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(true);
        expect(calls).toBe(2);
        expect(result.invocations[0].recoveryOutcome).toBe('recovered_by_retry');
        expect(emittedEvents.some((e) => e.event === 'execution.recovery_retry_scheduled')).toBe(true);
        expect(emittedEvents.some((e) => e.event === 'execution.recovery_succeeded')).toBe(true);
    });

    it('workflow dependency failure reroutes to declared equivalent target', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'retry' as const,
                    equivalentWorkflowIds: ['workflow.fallback'],
                })),
            },
        });

        const seen: string[] = [];
        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockImplementation(async (workflowId: string) => {
                seen.push(workflowId);
                if (workflowId === 'workflow.fallback') return { success: true, data: { ok: true } };
                return { success: false, error: 'network unreachable to primary workflow service' };
            }),
        };

        const result = await new WorkflowHandoffCoordinator(executor).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(true);
        expect(seen).toContain('workflow.fallback');
        expect(result.invocations[0].workflowId).toBe('workflow.fallback');
        expect(result.invocations[0].recoveryOutcome).toBe('recovered_by_reroute');
        expect(emittedEvents.some((e) => e.event === 'execution.recovery_reroute_selected')).toBe(true);
    });

    it('policy_blocked does not reroute around policy', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'retry' as const,
                    equivalentWorkflowIds: ['workflow.fallback'],
                })),
            },
        });

        const seen: string[] = [];
        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockImplementation(async (workflowId: string) => {
                seen.push(workflowId);
                return {
                    success: false,
                    error: new PolicyDeniedError({
                        allowed: false,
                        reason: 'blocked by policy',
                        code: 'policy:blocked',
                        metadata: {},
                    }).message,
                };
            }),
        };

        const result = await new WorkflowHandoffCoordinator(executor).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(false);
        expect(seen).not.toContain('workflow.fallback');
    });

    it('exhausted local workflow recovery emits one replan request', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'stop' as const,
                })),
            },
        });

        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'network unreachable' }),
        };

        const result = await new WorkflowHandoffCoordinator(executor).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(false);
        expect(result.replanAdvised).toBe(true);
        const replans = emittedEvents.filter((e) => e.event === 'execution.replan_requested');
        const dispatchFails = emittedEvents.filter((e) => e.event === 'planning.workflow_handoff_dispatch_failed');
        expect(replans).toHaveLength(1);
        expect(dispatchFails).toHaveLength(1);
    });

    it('anti-thrash suppression stops repeated retry attempts deterministically', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'retry' as const,
                })),
            },
        });

        const suppression = new FailureSuppressionService(
            { threshold: 1, windowMs: 60_000, cooldownMs: 60_000 },
            () => 1_000,
        );
        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'timeout while opening stream' }),
        };

        const result = await new WorkflowHandoffCoordinator(executor, suppression).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(true);
        expect(result.invocations[0].success).toBe(false);
        expect((executor.executeWorkflow as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
        expect(result.invocations[0].antiThrashSuppressed).toBe(true);
    });

    it('workflow degraded completion is surfaced explicitly', async () => {
        const { svc, repo, planId } = createWorkflowPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'workflow') throw new Error('expected workflow handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocations: plan.handoff.invocations.map((inv) => ({
                    ...inv,
                    failurePolicy: 'skip' as const,
                    degradeAllowed: true,
                })),
            },
        });

        const executor: IWorkflowExecutor = {
            executeWorkflow: vi.fn().mockResolvedValue({ success: false, error: 'partial response payload from dependency' }),
        };

        const result = await new WorkflowHandoffCoordinator(executor).dispatch(planId, new Set(['workflow_engine']));

        expect(result.success).toBe(true);
        expect(result.invocations[0].recoveryOutcome).toBe('degraded_but_completed');
        expect(emittedEvents.some((e) => e.event === 'execution.degraded_completed')).toBe(true);
    });

    it('agent reroutes to an equivalent agent and succeeds', async () => {
        const { svc, repo, planId } = createAgentPlan();
        const plan = svc.getPlan(planId)!;
        if (plan.handoff.type !== 'agent') throw new Error('expected agent handoff');

        repo.savePlan({
            ...plan,
            handoff: {
                ...plan.handoff,
                invocation: {
                    ...plan.handoff.invocation,
                    failurePolicy: 'retry' as const,
                    equivalentAgentIds: ['agent.fallback'],
                },
            },
        });

        const seen: string[] = [];
        const executor: IAgentExecutor = {
            executeAgent: vi.fn().mockImplementation(async (agentId: string) => {
                seen.push(agentId);
                if (agentId === 'agent.fallback') return { success: true, data: { ok: true } };
                return { success: false, error: 'network unreachable' };
            }),
        };

        const result = await new AgentHandoffCoordinator(executor).dispatch(planId, new Set(['inference', 'rag']));

        expect(result.success).toBe(true);
        expect(result.invocation?.recoveryOutcome).toBe('recovered_by_reroute');
        expect(seen).toContain('agent.fallback');
    });
});
