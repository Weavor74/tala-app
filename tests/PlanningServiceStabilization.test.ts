/**
 * PlanningServiceStabilization.test.ts
 *
 * Stabilization pass tests for the PlanningService subsystem (PS87–PS111).
 *
 * Coverage:
 *   PS87–PS91  — ISSUE 1: handoffTarget removed; ExecutionPlan has single handoff truth
 *   PS92–PS97  — ISSUE 2: Strengthened tool handoff contract (PlannedToolInvocation steps)
 *   PS98–PS101 — ISSUE 3: Execution-boundary identity (executionBoundaryId)
 *   PS102–PS106 — ISSUE 4: Replan rejection first-class (planning.replan_rejected event)
 *   PS107–PS110 — ISSUE 5: Capability provider failure honest and non-silent
 *   PS111      — ISSUE 6: planning:analyzeGoal IPC route registered
 *   PS112–PS118 — End-to-end tool handoff via PlanningHandoffCoordinator
 *
 * No DB, no Electron, no real IPC runtime.
 * TelemetryBus is stubbed.  All clocks are deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { PlanningHandoffCoordinator } from '../electron/services/planning/PlanningHandoffCoordinator';
import type { IToolExecutor } from '../electron/services/planning/PlanningHandoffCoordinator';
import type { ReplanPolicy } from '../shared/planning/PlanningTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function findAllEmittedPayloads(eventType: string): Array<Record<string, unknown>> {
    return emittedEvents
        .filter(e => e.event === eventType)
        .map(e => e.payload ?? {});
}

function findFirstEmittedPayload(eventType: string): Record<string, unknown> | undefined {
    return emittedEvents.find(e => e.event === eventType)?.payload;
}

function makeSuccessfulToolExecutor(): IToolExecutor {
    return {
        executeTool: vi.fn().mockResolvedValue({ success: true, data: { ok: true }, durationMs: 1 }),
    };
}

function makeFailingToolExecutor(errorMsg = 'tool failed'): IToolExecutor {
    return {
        executeTool: vi.fn().mockResolvedValue({ success: false, error: errorMsg, durationMs: 1 }),
    };
}

// ---------------------------------------------------------------------------
// PS87–PS91 — ISSUE 1: handoffTarget removed; single source of truth
// ---------------------------------------------------------------------------

describe('PS87–PS91 — handoffTarget removed; ExecutionPlan.handoff is single truth', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS87 — ExecutionPlan has no handoffTarget field', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        // handoffTarget must not exist on the plan object
        expect('handoffTarget' in plan).toBe(false);
    });

    it('PS88 — ExecutionPlan.handoff is the only handoff field', () => {
        const svc = freshService(['workflow_engine']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff).toBeDefined();
        expect(plan.handoff.type).toBe('workflow');
    });

    it('PS89 — planning.execution_handoff event carries handoffType (not handoffTarget)', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        const payload = findFirstEmittedPayload('planning.execution_handoff');
        expect(payload).toBeDefined();
        expect('handoffTarget' in (payload ?? {})).toBe(false);
        expect(payload?.handoffType).toBeTruthy();
    });

    it('PS90 — planning.plan_created event carries handoffType (not handoffTarget)', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        svc.buildPlan(g.id);
        const payload = findFirstEmittedPayload('planning.plan_created');
        expect(payload).toBeDefined();
        expect('handoffTarget' in (payload ?? {})).toBe(false);
        expect(payload?.handoffType).toBeTruthy();
    });

    it('PS91 — reasonCodes contains handoff:<type> (not handoff:WorkflowExecutionService etc.)', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'maintenance' }));
        const plan = svc.buildPlan(g.id);
        const handoffReasonCode = plan.reasonCodes.find(rc => rc.startsWith('handoff:'));
        expect(handoffReasonCode).toBeDefined();
        // Must be handoff:workflow not handoff:WorkflowExecutionService
        expect(handoffReasonCode).toMatch(/^handoff:(workflow|tool|agent|operator|none)$/);
    });
});

// ---------------------------------------------------------------------------
// PS92–PS97 — ISSUE 2: Strengthened tool handoff contract
// ---------------------------------------------------------------------------

describe('PS92–PS97 — Strengthened tool handoff contract (PlannedToolInvocation steps)', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS92 — tool_orchestrated goal produces handoff with steps array', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('tool');
        if (plan.handoff.type === 'tool') {
            expect(Array.isArray(plan.handoff.steps)).toBe(true);
        }
    });

    it('PS93 — tool handoff steps are non-empty for tool_orchestrated plan', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        if (plan.handoff.type === 'tool') {
            expect(plan.handoff.steps.length).toBeGreaterThan(0);
        }
    });

    it('PS94 — each step has toolId, input, and failurePolicy', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        if (plan.handoff.type === 'tool') {
            for (const step of plan.handoff.steps) {
                expect(typeof step.toolId).toBe('string');
                expect(step.toolId.length).toBeGreaterThan(0);
                expect(step.input).toBeDefined();
                expect(typeof step.input).toBe('object');
                expect(['stop', 'retry', 'skip', 'escalate']).toContain(step.failurePolicy);
            }
        }
    });

    it('PS95 — tool handoff has sharedInputs record', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        if (plan.handoff.type === 'tool') {
            expect(plan.handoff.sharedInputs).toBeDefined();
            expect(typeof plan.handoff.sharedInputs).toBe('object');
        }
    });

    it('PS96 — tool handoff does not have a toolIds array (old contract removed)', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        if (plan.handoff.type === 'tool') {
            expect('toolIds' in plan.handoff).toBe(false);
        }
    });

    it('PS97 — non-tool handoffs still have contractVersion 1', () => {
        const svc = freshService(['workflow_engine']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.contractVersion).toBe(1);
        expect(plan.handoff.type).toBe('workflow');
    });
});

// ---------------------------------------------------------------------------
// PS98–PS101 — ISSUE 3: Execution-boundary identity (executionBoundaryId)
// ---------------------------------------------------------------------------

describe('PS98–PS101 — executionBoundaryId on executing plans', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS98 — plan has no executionBoundaryId before markExecutionStarted', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(plan.executionBoundaryId).toBeUndefined();
    });

    it('PS99 — plan has executionBoundaryId after markExecutionStarted', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const executing = svc.markExecutionStarted(plan.id);
        expect(executing.executionBoundaryId).toBeTruthy();
        expect(typeof executing.executionBoundaryId).toBe('string');
    });

    it('PS100 — executionBoundaryId is different from plan.id and goal.id', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const executing = svc.markExecutionStarted(plan.id);
        expect(executing.executionBoundaryId).not.toBe(plan.id);
        expect(executing.executionBoundaryId).not.toBe(g.id);
    });

    it('PS101 — planning.execution_handoff event includes executionBoundaryId', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        const executing = svc.markExecutionStarted(plan.id);
        const payload = findFirstEmittedPayload('planning.execution_handoff');
        expect(payload?.executionBoundaryId).toBeTruthy();
        expect(payload?.executionBoundaryId).toBe(executing.executionBoundaryId);
    });
});

// ---------------------------------------------------------------------------
// PS102–PS106 — ISSUE 4: Replan rejection first-class and observable
// ---------------------------------------------------------------------------

describe('PS102–PS106 — Replan rejection emits planning.replan_rejected', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS102 — REPLAN_LIMIT_EXCEEDED emits planning.replan_rejected before throwing', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 1, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        emittedEvents.length = 0; // clear events before the rejected replan
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' })
        ).toThrow(PlanningError);
        const rejectedPayloads = findAllEmittedPayloads('planning.replan_rejected');
        expect(rejectedPayloads.length).toBe(1);
        expect(rejectedPayloads[0].rejectionCode).toBe('REPLAN_LIMIT_EXCEEDED');
    });

    it('PS103 — REPLAN_COOLDOWN_ACTIVE emits planning.replan_rejected before throwing', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 10, cooldownMs: 60_000 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        emittedEvents.length = 0;
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' })
        ).toThrow(PlanningError);
        const rejectedPayloads = findAllEmittedPayloads('planning.replan_rejected');
        expect(rejectedPayloads.length).toBe(1);
        expect(rejectedPayloads[0].rejectionCode).toBe('REPLAN_COOLDOWN_ACTIVE');
    });

    it('PS104 — replan_rejected payload includes goalId and priorPlanId', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 0, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' })
        ).toThrow();
        const rejected = findFirstEmittedPayload('planning.replan_rejected');
        expect(rejected?.goalId).toBe(g.id);
        expect(rejected?.priorPlanId).toBe(plan.id);
    });

    it('PS105 — replan_rejected payload includes trigger', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 0, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'capability_loss' })
        ).toThrow();
        const rejected = findFirstEmittedPayload('planning.replan_rejected');
        expect(rejected?.trigger).toBe('capability_loss');
    });

    it('PS106 — successful replan does NOT emit planning.replan_rejected', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 5, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        expect(findAllEmittedPayloads('planning.replan_rejected')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// PS107–PS110 — ISSUE 5: Capability provider failure honest and non-silent
// ---------------------------------------------------------------------------

describe('PS107–PS110 — Capability provider failure is observable', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS107 — capability provider error emits planning.capability_provider_error event', () => {
        const svc = freshService(['workflow_engine']);
        svc.registerCapabilityProvider(() => {
            throw new Error('provider unavailable');
        });
        const g = svc.registerGoal(basicGoalInput());
        svc.analyzeGoal(g.id);
        const errorPayloads = findAllEmittedPayloads('planning.capability_provider_error');
        expect(errorPayloads.length).toBe(1);
        expect(typeof errorPayloads[0].error).toBe('string');
        expect(errorPayloads[0].error).toContain('provider unavailable');
    });

    it('PS108 — when provider fails, analyzeGoal falls back to manually-set capabilities', () => {
        // Manual caps = full set (can analyze workflow goal without blocking)
        const svc = freshService(['workflow_engine', 'memory_canonical']);
        svc.registerCapabilityProvider(() => {
            throw new Error('crash');
        });
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        // Should succeed using fallback capabilities, not block
        expect(analysis.blockingIssues).toHaveLength(0);
    });

    it('PS109 — capability_provider_error payload includes fallback indicator', () => {
        const svc = freshService([]);
        svc.registerCapabilityProvider(() => { throw new Error('boom'); });
        const g = svc.registerGoal(basicGoalInput());
        svc.analyzeGoal(g.id);
        const payload = findFirstEmittedPayload('planning.capability_provider_error');
        expect(payload?.fallback).toBe('manual_capabilities');
    });

    it('PS110 — working capability provider does not emit capability_provider_error', () => {
        const svc = freshService([]);
        svc.registerCapabilityProvider(() => new Set(['workflow_engine']));
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        svc.analyzeGoal(g.id);
        expect(findAllEmittedPayloads('planning.capability_provider_error')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// PS111 — ISSUE 6: planning:analyzeGoal IPC route registered
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPC_ROUTER_PATH = path.join(REPO_ROOT, 'electron/services/IpcRouter.ts');

function extractIpcChannels(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
    const channels: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        channels.push(m[1]);
    }
    return channels;
}

describe('PS111 — IPC route planning:analyzeGoal', () => {
    it('PS111 — planning:analyzeGoal is registered in IpcRouter.ts', () => {
        const channels = extractIpcChannels(IPC_ROUTER_PATH);
        expect(channels).toContain('planning:analyzeGoal');
    });
});

// ---------------------------------------------------------------------------
// PS112–PS118 — End-to-end tool handoff via PlanningHandoffCoordinator
// ---------------------------------------------------------------------------

describe('PS112–PS118 — PlanningHandoffCoordinator end-to-end tool path', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS112 — dispatcher.dispatch() calls toolExecutor for each step', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);

        const executor = makeSuccessfulToolExecutor();
        const dispatcher = new PlanningHandoffCoordinator(executor);

        const result = await dispatcher.dispatch(plan.id);

        expect(result.success).toBe(true);
        expect(result.planId).toBe(plan.id);
        expect((executor.executeTool as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it('PS113 — dispatcher marks plan as completed on full success', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);

        const dispatcher = new PlanningHandoffCoordinator(makeSuccessfulToolExecutor());
        await dispatcher.dispatch(plan.id);

        const updated = svc.getPlan(plan.id);
        expect(updated?.status).toBe('completed');
    });

    it('PS114 — dispatcher marks plan as failed when step with stop policy fails', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        if (plan.handoff.type !== 'tool') return; // type guard

        const dispatcher = new PlanningHandoffCoordinator(makeFailingToolExecutor('step error'));
        const result = await dispatcher.dispatch(plan.id);

        expect(result.success).toBe(false);
        const updated = svc.getPlan(plan.id);
        expect(updated?.status).toBe('failed');
    });

    it('PS115 — dispatcher emits planning.handoff_dispatched event', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);

        const dispatcher = new PlanningHandoffCoordinator(makeSuccessfulToolExecutor());
        await dispatcher.dispatch(plan.id);

        const dispatched = findFirstEmittedPayload('planning.handoff_dispatched');
        expect(dispatched).toBeDefined();
        expect(dispatched?.planId).toBe(plan.id);
        expect(dispatched?.handoffType).toBe('tool');
    });

    it('PS116 — dispatcher passes executionBoundaryId to tool executor context', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);

        const capturedCtxs: Array<Record<string, unknown>> = [];
        const executor: IToolExecutor = {
            executeTool: vi.fn().mockImplementation((_name, _args, _allowed, ctx) => {
                if (ctx) capturedCtxs.push(ctx as Record<string, unknown>);
                return Promise.resolve({ success: true, data: {}, durationMs: 1 });
            }),
        };

        const dispatcher = new PlanningHandoffCoordinator(executor);
        await dispatcher.dispatch(plan.id);

        expect(capturedCtxs.length).toBeGreaterThan(0);
        for (const ctx of capturedCtxs) {
            expect(typeof ctx.executionId).toBe('string');
            expect(ctx.executionId).toMatch(/^exec-/);
        }
    });

    it('PS117 — dispatcher throws for non-tool handoff types', async () => {
        const svc = freshService(['workflow_engine']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('workflow');

        const dispatcher = new PlanningHandoffCoordinator(makeSuccessfulToolExecutor());
        await expect(dispatcher.dispatch(plan.id)).rejects.toThrow(/only 'tool' handoff/);
    });

    it('PS118 — dispatcher dispatch result includes step results with toolId', async () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);

        const dispatcher = new PlanningHandoffCoordinator(makeSuccessfulToolExecutor());
        const result = await dispatcher.dispatch(plan.id);

        expect(result.steps.length).toBeGreaterThan(0);
        for (const step of result.steps) {
            expect(typeof step.toolId).toBe('string');
            expect(step.toolId.length).toBeGreaterThan(0);
        }
    });
});
