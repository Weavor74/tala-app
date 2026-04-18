import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';
import { SystemModeManager } from '../electron/services/SystemModeManager';
import type { PlanningLoopRun } from '../shared/planning/planningLoopTypes';
import type { SystemHealthSnapshot } from '../shared/system-health-types';

const stubTurnOutput = {
    message: 'ok',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function makeKernel() {
    const agentStub = {
        chat: vi.fn().mockResolvedValue(stubTurnOutput),
    };
    const kernel = new AgentKernel(agentStub as any);
    return { kernel, agentStub };
}

function makeLoopRun(overrides?: Partial<PlanningLoopRun>): PlanningLoopRun {
    const base: PlanningLoopRun = {
        loopId: 'loop-1',
        correlationId: 'corr-1',
        goal: 'goal',
        phase: 'completed',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        currentIteration: 0,
        maxIterations: 1,
        goalId: 'goal-1',
        currentPlanId: 'plan-1',
        executionBoundaryId: 'boundary-1',
        replanHistory: [],
    };
    return { ...base, ...(overrides ?? {}) };
}

function makeHealthSnapshot(overrides?: Partial<SystemHealthSnapshot>): SystemHealthSnapshot {
    const base: SystemHealthSnapshot = {
        timestamp: new Date(0).toISOString(),
        overall_status: 'degraded',
        subsystem_entries: [],
        trust_score: 0.8,
        degraded_capabilities: ['autonomy_execute'],
        blocked_capabilities: [],
        active_fallbacks: [],
        active_incidents: [],
        pending_repairs: [],
        current_mode: 'DEGRADED_AUTONOMY',
        effective_mode: 'DEGRADED_AUTONOMY',
        active_degradation_flags: ['DEGRADED_AUTONOMY'],
        mode_contract: {
            mode: 'DEGRADED_AUTONOMY',
            entry_conditions: [],
            exit_conditions: [],
            allowed_capabilities: ['chat_inference', 'memory_canonical_read'],
            blocked_capabilities: ['autonomy_execute'],
            fallback_behavior: [],
            user_facing_behavior_changes: [],
            telemetry_expectations: [],
            operator_actions_allowed: [],
            autonomy_allowed: false,
            writes_allowed: false,
            operator_approval_required_for: [],
        },
        recent_mode_transitions: [],
        capability_matrix: [
            {
                capability: 'chat_inference',
                status: 'available',
                reason: 'ok',
                approval_required: false,
                impacted_by: [],
            },
            {
                capability: 'autonomy_execute',
                status: 'blocked',
                reason: 'degraded',
                approval_required: false,
                impacted_by: ['autonomy_orchestrator'],
            },
        ],
        active_incident_entries: [],
        trust_explanation: {
            telemetry_freshness: {
                inference_age_ms: 0,
                mcp_age_ms: 0,
                expected_max_age_ms: 1000,
            },
            last_successful_subsystem_check: null,
            stale_components: [],
            missing_evidence: [],
            suppressed_assumptions: [],
            confidence_penalties: [],
        },
        trust_score_inputs: {
            inference_age_ms: 0,
            mcp_age_ms: 0,
            expected_max_age_ms: 1000,
            db_evidence_observed: true,
            telemetry_stream_observed: true,
        },
        operator_attention_required: false,
    };
    return { ...base, ...(overrides ?? {}) };
}

describe('AgentKernel turn arbitration integration', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('emits exactly one arbitration decision per turn', async () => {
        const { kernel } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));

        await kernel.execute({ userMessage: 'explain the current status' });

        const arbitrateEvents = events.filter((e) => e.event === 'kernel.turn_arbitrated');
        expect(arbitrateEvents).toHaveLength(1);
    });

    it('conversational branch does not invoke planning loop', async () => {
        const { kernel, agentStub } = makeKernel();
        const startLoopSpy = vi.spyOn(PlanningLoopService.getInstance(), 'startLoop');

        await kernel.execute({
            userMessage: 'summarize this diff for me',
            operatorMode: 'chat',
        });

        expect(startLoopSpy).not.toHaveBeenCalled();
        expect(agentStub.chat).toHaveBeenCalledOnce();
    });

    it('goal_execution branch invokes planning loop with explicit metadata', async () => {
        const { kernel } = makeKernel();
        const startLoopSpy = vi.spyOn(PlanningLoopService.getInstance(), 'startLoop');

        await kernel.execute({
            userMessage: 'implement the fix and run tests',
            operatorMode: 'goal',
        });

        expect(startLoopSpy).toHaveBeenCalledOnce();
        const input = startLoopSpy.mock.calls[0][0];
        expect(input.planningInvocation).toMatchObject({
            invokedBy: 'agent_kernel',
            invocationReason: 'goal_execution_turn',
            turnMode: 'goal_execution',
        });
    });

    it('plan_blocked + degraded autonomy + summary task degrades to direct fallback', async () => {
        const { kernel, agentStub } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));

        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue(makeHealthSnapshot());
        vi.spyOn(PlanningLoopService.getInstance(), 'startLoop').mockResolvedValue(
            makeLoopRun({
                phase: 'failed',
                failureReason: 'plan_blocked',
                failureDetail: 'degraded_autonomy',
            }),
        );

        const result = await kernel.execute({
            userMessage: 'Please summarize ONLY the following notebook sources',
            operatorMode: 'goal',
        });

        expect(result.outputChannel).toBe('chat');
        expect(agentStub.chat).toHaveBeenCalledOnce();
        expect(events.some((e) => e.event === 'planning.plan_blocked_recovery_requested')).toBe(true);
        expect(events.some((e) => e.event === 'planning.plan_blocked_recovery_resolved')).toBe(true);
        expect(events.some((e) => e.event === 'execution.degraded_fallback_applied')).toBe(true);
        expect(events.some((e) => e.event === 'planning.plan_blocked_recovered')).toBe(true);
    });

    it('plan_blocked replannable condition triggers replan path', async () => {
        const { kernel, agentStub } = makeKernel();
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue(
            makeHealthSnapshot({
                effective_mode: 'NORMAL',
                active_degradation_flags: [],
                subsystem_entries: [],
                capability_matrix: [
                    {
                        capability: 'autonomy_execute',
                        status: 'available',
                        reason: 'ok',
                        approval_required: false,
                        impacted_by: [],
                    },
                ],
            }),
        );
        vi.spyOn(PlanningLoopService.getInstance(), 'startLoop').mockResolvedValue(
            makeLoopRun({
                phase: 'failed',
                failureReason: 'plan_blocked',
                goalId: 'goal-replan',
                currentPlanId: 'plan-replan',
            }),
        );
        const replanSpy = vi.spyOn(PlanningService.getInstance(), 'replan');

        const result = await kernel.execute({
            userMessage: 'Implement the fix and run tests',
            operatorMode: 'goal',
        });

        expect(replanSpy).toHaveBeenCalledOnce();
        expect(result.outputChannel).toBe('fallback');
        expect(result.message).toContain('replan');
        expect(agentStub.chat).not.toHaveBeenCalled();
    });

    it('plan_blocked policy/approval issue escalates without generic crash', async () => {
        const { kernel, agentStub } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue(makeHealthSnapshot());
        vi.spyOn(PlanningLoopService.getInstance(), 'startLoop').mockResolvedValue(
            makeLoopRun({
                phase: 'failed',
                failureReason: 'plan_blocked',
                failureDetail: 'approval_required',
            }),
        );

        const result = await kernel.execute({
            userMessage: 'Summarize this source set',
            operatorMode: 'goal',
        });

        expect(result.outputChannel).toBe('fallback');
        expect(result.message).toContain('operator review');
        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(events.some((e) => e.event === 'planning.plan_blocked_escalated')).toBe(true);
    });

    it('unrecoverable plan_blocked terminates explicitly with reasonCode', async () => {
        const { kernel } = makeKernel();
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue(
            makeHealthSnapshot({
                effective_mode: 'NORMAL',
                active_degradation_flags: [],
                capability_matrix: [
                    {
                        capability: 'autonomy_execute',
                        status: 'available',
                        reason: 'ok',
                        approval_required: false,
                        impacted_by: [],
                    },
                ],
            }),
        );
        vi.spyOn(PlanningLoopService.getInstance(), 'startLoop').mockResolvedValue(
            makeLoopRun({
                phase: 'failed',
                failureReason: 'plan_blocked',
                failureDetail: 'unrecoverable_no_valid_path',
                goalId: undefined,
                currentPlanId: undefined,
            }),
        );

        await expect(
            kernel.execute({
                userMessage: 'Run this high-risk authority action',
                operatorMode: 'goal',
            }),
        ).rejects.toThrow('reasonCode=plan_blocked.recover.terminate.no_safe_path');
    });

    it('plan_blocked recovery telemetry preserves execution identity', async () => {
        const { kernel } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => events.push(e));
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue(makeHealthSnapshot());
        vi.spyOn(PlanningLoopService.getInstance(), 'startLoop').mockResolvedValue(
            makeLoopRun({
                phase: 'failed',
                failureReason: 'plan_blocked',
                failureDetail: 'degraded_autonomy',
                executionBoundaryId: 'boundary-identity',
            }),
        );

        const result = await kernel.execute({
            userMessage: 'Summarize this notebook source',
            operatorMode: 'goal',
        });

        const recoveryEvents = events.filter(
            (event) => event.event.startsWith('planning.plan_blocked_') || event.event === 'execution.degraded_fallback_applied',
        );
        expect(recoveryEvents.length).toBeGreaterThan(0);
        for (const event of recoveryEvents) {
            expect(event.executionId).toBe(result.meta.executionId);
            expect(event.payload?.executionBoundaryId).toBe('boundary-identity');
        }
    });
});
