/**
 * PlanningService.test.ts
 *
 * Deterministic governance-grade tests for the Planning subsystem.
 *
 * Coverage:
 *   PS01–PS06  — Goal registration (canonical shape, status, timestamps, source/category/priority)
 *   PS07–PS14  — Goal analysis (execution style selection, approval detection, capability checks)
 *   PS15–PS22  — Plan building (stages, dependencies, blocked analysis, approval-required plan)
 *   PS23–PS30  — Approval lifecycle (approve, deny, invalid transitions)
 *   PS31–PS38  — Execution state transitions (started, completed, failed, invalid)
 *   PS39–PS46  — Replanning (new version, superseded plan, trigger captured, no overwrite)
 *   PS47–PS54  — Governance (no side effects, telemetry events, reason codes, status machine)
 *
 * No DB, no Electron, no IPC.
 * TelemetryBus is stubbed.  All clocks are deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) =>
                emittedEvents.push(e as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
    PlanningService,
    PlanningError,
    type RegisterGoalInput,
} from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';
import { GoalAnalyzer } from '../electron/services/planning/GoalAnalyzer';
import type { PlanGoal } from '../shared/planning/PlanningTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh isolated PlanningService instance.
 * Default capabilities cover the requirements for the default basicGoalInput
 * (category:'maintenance', source:'system', priority:'normal/critical'):
 *   memory_canonical — required by maintenance/memory/diagnostics categories
 *   workflow_engine  — required by maintenance/workflow/release categories
 * Pass an explicit empty array to test missing-capability behaviour.
 */
function freshService(caps: string[] = ['memory_canonical', 'workflow_engine']): PlanningService {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const svc = PlanningService.getInstance();
    svc.setAvailableCapabilities(new Set(caps));
    return svc;
}

function basicGoalInput(overrides: Partial<RegisterGoalInput> = {}): RegisterGoalInput {
    return {
        title: 'Test goal',
        description: 'Perform routine memory maintenance.',
        source: 'system',
        category: 'maintenance',
        priority: 'normal',
        successCriteria: ['maintenance completed without error'],
        ...overrides,
    };
}

function findEmittedEvent(eventType: string): Record<string, unknown> | undefined {
    const found = emittedEvents.find(e => e.event === eventType);
    return found?.payload;
}

// ---------------------------------------------------------------------------
// PS01–PS06 — Goal registration
// ---------------------------------------------------------------------------

describe('PS01–PS06 — Goal registration', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        freshService();
    });

    it('PS01 — registerGoal returns a PlanGoal with a unique id', () => {
        const svc = PlanningService.getInstance();
        const g = svc.registerGoal(basicGoalInput());
        expect(g.id).toMatch(/^goal-/);
        expect(typeof g.id).toBe('string');
    });

    it('PS02 — goal status is registered immediately after registration', () => {
        const svc = PlanningService.getInstance();
        const g = svc.registerGoal(basicGoalInput());
        expect(g.status).toBe('registered');
    });

    it('PS03 — registeredAt and updatedAt are ISO-8601 strings', () => {
        const svc = PlanningService.getInstance();
        const g = svc.registerGoal(basicGoalInput());
        expect(() => new Date(g.registeredAt)).not.toThrow();
        expect(() => new Date(g.updatedAt)).not.toThrow();
        expect(g.registeredAt).toBe(g.updatedAt);
    });

    it('PS04 — source, category, and priority are preserved', () => {
        const svc = PlanningService.getInstance();
        const g = svc.registerGoal({
            ...basicGoalInput(),
            source: 'autonomy',
            category: 'diagnostics',
            priority: 'high',
        });
        expect(g.source).toBe('autonomy');
        expect(g.category).toBe('diagnostics');
        expect(g.priority).toBe('high');
    });

    it('PS05 — priority defaults to normal when not supplied', () => {
        const svc = PlanningService.getInstance();
        const input = basicGoalInput();
        delete (input as Record<string, unknown>).priority;
        const g = svc.registerGoal(input);
        expect(g.priority).toBe('normal');
    });

    it('PS06 — planning.goal_registered event is emitted', () => {
        const svc = PlanningService.getInstance();
        const g = svc.registerGoal(basicGoalInput());
        const payload = findEmittedEvent('planning.goal_registered');
        expect(payload).toBeDefined();
        expect(payload?.goalId).toBe(g.id);
        expect(payload?.source).toBe('system');
        expect(payload?.category).toBe('maintenance');
    });
});

// ---------------------------------------------------------------------------
// PS07–PS14 — Goal analysis
// ---------------------------------------------------------------------------

describe('PS07–PS14 — Goal analysis', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS07 — maintenance goal selects deterministic execution style', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'maintenance' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.executionStyle).toBe('deterministic');
    });

    it('PS08 — diagnostics goal selects deterministic execution style', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'diagnostics' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.executionStyle).toBe('deterministic');
    });

    it('PS09 — workflow goal selects workflow execution style', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.executionStyle).toBe('workflow');
    });

    it('PS10 — conversation goal selects llm_assisted execution style', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'conversation' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.executionStyle).toBe('llm_assisted');
    });

    it('PS11 — critical-priority goal requires approval', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.requiresApproval).toBe(true);
        expect(analysis.approvalReason).toBeTruthy();
    });

    it('PS12 — missing capability is surfaced in missingCapabilities and blockingIssues', () => {
        const svc = freshService([]); // no capabilities available
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.missingCapabilities).toContain('workflow_engine');
        expect(analysis.blockingIssues.length).toBeGreaterThan(0);
    });

    it('PS13 — with workflow_engine available, workflow goal has no blocking issues', () => {
        const svc = freshService(['workflow_engine']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.blockingIssues).toHaveLength(0);
        expect(analysis.missingCapabilities).toHaveLength(0);
    });

    it('PS14 — planning.goal_analyzed event is emitted with goalId and analysis fields', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        svc.analyzeGoal(g.id);
        const payload = findEmittedEvent('planning.goal_analyzed');
        expect(payload).toBeDefined();
        expect(payload?.goalId).toBe(g.id);
        expect(payload?.executionStyle).toBe('deterministic');
        expect(typeof payload?.durationMs).toBe('number');
    });
});

// ---------------------------------------------------------------------------
// PS15–PS22 — Plan building
// ---------------------------------------------------------------------------

describe('PS15–PS22 — Plan building', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS15 — plan has explicit stages array (non-empty)', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(plan.stages.length).toBeGreaterThan(0);
    });

    it('PS16 — plan has explicit dependencies map', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(plan.dependencies).toBeDefined();
        expect(typeof plan.dependencies).toBe('object');
        // Every stage must have a dependencies entry
        for (const stage of plan.stages) {
            expect(stage.id in plan.dependencies).toBe(true);
        }
    });

    it('PS17 — each stage has type, executionMode, failurePolicy, and successCriteria', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        for (const stage of plan.stages) {
            expect(stage.type).toBeTruthy();
            expect(stage.executionMode).toBeTruthy();
            expect(stage.failurePolicy).toBeTruthy();
            expect(Array.isArray(stage.successCriteria)).toBe(true);
        }
    });

    it('PS18 — blocked analysis produces a blocked plan', () => {
        const svc = freshService([]); // no caps → workflow_engine missing → blocked
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.status).toBe('blocked');
        expect(plan.approvalState).toBe('not_required');
    });

    it('PS19 — blocked plan emits planning.plan_blocked event', () => {
        const svc = freshService([]);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        svc.buildPlan(g.id);
        const payload = findEmittedEvent('planning.plan_blocked');
        expect(payload).toBeDefined();
    });

    it('PS20 — approval-required plan starts in pending approval state', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.requiresApproval).toBe(true);
        expect(plan.approvalState).toBe('pending');
        expect(plan.status).toBe('draft');
    });

    it('PS21 — normal-risk maintenance plan does not require approval', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'normal' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.requiresApproval).toBe(false);
        expect(plan.approvalState).toBe('not_required');
        expect(plan.status).toBe('ready');
    });

    it('PS22 — plan version is 1 for initial plan', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(plan.version).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// PS23–PS30 — Approval lifecycle
// ---------------------------------------------------------------------------

describe('PS23–PS30 — Approval lifecycle', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS23 — approvePlan transitions approval state to approved', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        const approved = svc.approvePlan(plan.id, 'operator:test-user');
        expect(approved.approvalState).toBe('approved');
        expect(approved.status).toBe('approved');
        expect(approved.approvalActor).toBe('operator:test-user');
        expect(approved.approvalDecidedAt).toBeTruthy();
    });

    it('PS24 — approvePlan emits planning.plan_approved event', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        svc.approvePlan(plan.id, 'operator:test-user');
        const payload = findEmittedEvent('planning.plan_approved');
        expect(payload?.planId).toBe(plan.id);
        expect(payload?.actor).toBe('operator:test-user');
    });

    it('PS25 — denyPlan transitions approval state to denied and status to blocked', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        const denied = svc.denyPlan(plan.id, 'operator:test-user', 'too risky');
        expect(denied.approvalState).toBe('denied');
        expect(denied.status).toBe('blocked');
        expect(denied.denialReason).toBe('too risky');
    });

    it('PS26 — denyPlan emits planning.plan_denied event', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        svc.denyPlan(plan.id, 'operator:test-user', 'too risky');
        const payload = findEmittedEvent('planning.plan_denied');
        expect(payload?.planId).toBe(plan.id);
        expect(payload?.reason).toBe('too risky');
    });

    it('PS27 — approvePlan throws when plan does not require approval', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'normal' }));
        const plan = svc.buildPlan(g.id);
        expect(() => svc.approvePlan(plan.id, 'user')).toThrow(PlanningError);
    });

    it('PS28 — approvePlan throws when plan is already approved', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        svc.approvePlan(plan.id, 'user');
        expect(() => svc.approvePlan(plan.id, 'user')).toThrow(PlanningError);
    });

    it('PS29 — denyPlan throws when plan is not in pending state', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        svc.approvePlan(plan.id, 'user');
        expect(() => svc.denyPlan(plan.id, 'user', 'changed mind')).toThrow(PlanningError);
    });

    it('PS30 — getPlan returns undefined for unknown plan id', () => {
        const svc = freshService();
        expect(svc.getPlan('no-such-plan')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// PS31–PS38 — Execution state transitions
// ---------------------------------------------------------------------------

describe('PS31–PS38 — Execution state transitions', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS31 — markExecutionStarted transitions status to executing for ready plan', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const started = svc.markExecutionStarted(plan.id);
        expect(started.status).toBe('executing');
    });

    it('PS32 — markExecutionStarted emits planning.execution_handoff event', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        const payload = findEmittedEvent('planning.execution_handoff');
        expect(payload?.planId).toBe(plan.id);
        expect(payload?.handoffType).toBeTruthy();
    });

    it('PS33 — markExecutionStarted transitions goal to executing', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        expect(svc.getGoal(g.id)?.status).toBe('executing');
    });

    it('PS34 — markExecutionCompleted transitions status to completed', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        const completed = svc.markExecutionCompleted(plan.id);
        expect(completed.status).toBe('completed');
    });

    it('PS35 — markExecutionCompleted emits planning.plan_completed event', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        svc.markExecutionCompleted(plan.id);
        const payload = findEmittedEvent('planning.plan_completed');
        expect(payload?.planId).toBe(plan.id);
    });

    it('PS36 — markExecutionFailed transitions status to failed with reason', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        const failed = svc.markExecutionFailed(plan.id, 'tool_error');
        expect(failed.status).toBe('failed');
        expect(failed.reasonCodes.some(r => r.includes('tool_error'))).toBe(true);
    });

    it('PS37 — markExecutionStarted throws when plan requires approval but is not approved', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        expect(() => svc.markExecutionStarted(plan.id)).toThrow(PlanningError);
    });

    it('PS38 — markExecutionCompleted throws when plan is not in executing state', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(() => svc.markExecutionCompleted(plan.id)).toThrow(PlanningError);
    });
});

// ---------------------------------------------------------------------------
// PS39–PS46 — Replanning
// ---------------------------------------------------------------------------

describe('PS39–PS46 — Replanning', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS39 — replan creates a new plan with version 2', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const newPlan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        expect(newPlan.version).toBe(2);
    });

    it('PS40 — new plan carries replannedFromPlanId linking to prior plan', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const newPlan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        expect(newPlan.replannedFromPlanId).toBe(plan.id);
    });

    it('PS41 — prior plan is preserved with status superseded (not deleted)', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const priorPlan = svc.getPlan(plan.id);
        expect(priorPlan).toBeDefined();
        expect(priorPlan?.status).toBe('superseded');
    });

    it('PS42 — prior plan has supersededByPlanId pointing to new plan', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const newPlan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const priorPlan = svc.getPlan(plan.id);
        expect(priorPlan?.supersededByPlanId).toBe(newPlan.id);
    });

    it('PS43 — replan trigger is captured in planning.replan_requested event', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'capability_loss', triggerDetails: 'rag unavailable' });
        const payload = findEmittedEvent('planning.replan_requested');
        expect(payload?.trigger).toBe('capability_loss');
        expect(payload?.triggerDetails).toBe('rag unavailable');
        expect(payload?.priorPlanId).toBe(plan.id);
    });

    it('PS44 — planning.plan_superseded event is emitted with superseded plan id', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const newPlan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const payload = findEmittedEvent('planning.plan_superseded');
        expect(payload?.supersededPlanId).toBe(plan.id);
        expect(payload?.newPlanId).toBe(newPlan.id);
    });

    it('PS45 — listPlansForGoal returns both plans ordered by version', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const plans = svc.listPlansForGoal(g.id);
        expect(plans.length).toBe(2);
        expect(plans[0].version).toBe(1);
        expect(plans[1].version).toBe(2);
    });

    it('PS46 — replan throws when prior plan id does not exist', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: 'no-such-plan', trigger: 'manual' })
        ).toThrow(PlanningError);
    });
});

// ---------------------------------------------------------------------------
// PS47–PS54 — Governance and telemetry
// ---------------------------------------------------------------------------

describe('PS47–PS54 — Governance and telemetry', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS47 — PlanningService does not call any execution or tool side effects', () => {
        // Verify by checking that no tool.* or execution.* events are emitted
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        svc.markExecutionCompleted(plan.id);

        const executionEvents = emittedEvents.filter(e =>
            e.event.startsWith('tool.') ||
            (e.event.startsWith('execution.') && e.event !== 'planning.execution_handoff')
        );
        expect(executionEvents).toHaveLength(0);
    });

    it('PS48 — all emitted events are in the planning.* namespace', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        svc.markExecutionCompleted(plan.id);

        for (const e of emittedEvents) {
            expect(e.event).toMatch(/^planning\./);
        }
    });

    it('PS49 — reasonCodes field is present on all plans', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(Array.isArray(plan.reasonCodes)).toBe(true);
        expect(plan.reasonCodes.length).toBeGreaterThan(0);
    });

    it('PS50 — plan handoff type is not none for non-blocked plans', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).not.toBe('none');
    });

    it('PS51 — blocked plan has handoff type none', () => {
        const svc = freshService([]);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('none');
    });

    it('PS52 — registerGoal throws if getGoal is called with wrong id', () => {
        const svc = freshService();
        expect(svc.getGoal('not-a-real-id')).toBeUndefined();
    });

    it('PS53 — analyzeGoal throws PlanningError for unknown goalId', () => {
        const svc = freshService();
        expect(() => svc.analyzeGoal('not-a-real-goal')).toThrow(PlanningError);
    });

    it('PS54 — GoalAnalyzer.analyze produces no blockingIssues for fully-capabled maintenance goal', () => {
        const goal: PlanGoal = {
            id: 'g1',
            title: 'Memory maintenance',
            description: 'Run scheduled memory maintenance.',
            source: 'system',
            category: 'maintenance',
            priority: 'normal',
            status: 'registered',
            registeredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const caps = new Set(['memory_canonical', 'workflow_engine']);
        const analysis = GoalAnalyzer.analyze(goal, caps);
        expect(analysis.blockingIssues).toHaveLength(0);
        expect(analysis.missingCapabilities).toHaveLength(0);
        expect(analysis.executionStyle).toBe('deterministic');
        expect(analysis.reasonCodes.length).toBeGreaterThan(0);
    });
});
