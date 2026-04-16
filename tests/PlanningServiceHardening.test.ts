/**
 * PlanningServiceHardening.test.ts
 *
 * Hardening pass tests for the PlanningService subsystem (PS55–PS86).
 *
 * Coverage:
 *   PS55–PS60  — Typed ExecutionHandoff discriminated union
 *   PS61–PS66  — Correlation IDs across planning lifecycle
 *   PS67–PS72  — Replan guardrails (limit + cooldown)
 *   PS73–PS78  — Richer ApprovalContext model
 *   PS79–PS83  — Non-manual capability provider
 *   PS84–PS86  — IPC surface channel registration (static source scan)
 *
 * No DB, no Electron, no IPC runtime.
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

function findEmittedPayload(eventType: string): Record<string, unknown> | undefined {
    return emittedEvents.find(e => e.event === eventType)?.payload;
}

function findAllEmittedPayloads(eventType: string): Array<Record<string, unknown>> {
    return emittedEvents
        .filter(e => e.event === eventType)
        .map(e => e.payload ?? {});
}

// ---------------------------------------------------------------------------
// PS55–PS60 — Typed ExecutionHandoff discriminated union
// ---------------------------------------------------------------------------

describe('PS55–PS60 — Typed ExecutionHandoff discriminated union', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS55 — deterministic/maintenance plan handoff has type workflow', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ category: 'maintenance' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('workflow');
    });

    it('PS56 — workflow plan handoff has workflowId populated', () => {
        const svc = freshService(['workflow_engine']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('workflow');
        if (plan.handoff.type === 'workflow') {
            expect(plan.handoff.workflowId).toBeTruthy();
            expect(typeof plan.handoff.workflowId).toBe('string');
        }
    });

    it('PS57 — tool_orchestrated goal produces handoff type tool', () => {
        const svc = freshService(['tool_execution']);
        const g = svc.registerGoal(basicGoalInput({ category: 'tooling' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('tool');
    });

    it('PS58 — llm_assisted plan produces handoff type agent', () => {
        const svc = freshService(['inference', 'rag']);
        const g = svc.registerGoal(basicGoalInput({ category: 'conversation' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('agent');
        if (plan.handoff.type === 'agent') {
            expect(['llm_assisted', 'hybrid']).toContain(plan.handoff.executionMode);
        }
    });

    it('PS59 — blocked plan produces handoff type none', () => {
        const svc = freshService([]); // no caps — workflow goal blocks
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.handoff.type).toBe('none');
        if (plan.handoff.type === 'none') {
            expect(plan.handoff.reason).toBeTruthy();
        }
    });

    it('PS60 — contractVersion is always 1 on all handoff types', () => {
        const svcWorkflow = freshService(['workflow_engine']);
        const gw = svcWorkflow.registerGoal(basicGoalInput({ category: 'workflow' }));
        const pw = svcWorkflow.buildPlan(gw.id);
        expect(pw.handoff.contractVersion).toBe(1);

        const svcBlocked = freshService([]);
        const gb = svcBlocked.registerGoal(basicGoalInput({ category: 'workflow' }));
        const pb = svcBlocked.buildPlan(gb.id);
        expect(pb.handoff.contractVersion).toBe(1);

        const svcConv = freshService(['inference']);
        const gc = svcConv.registerGoal(basicGoalInput({ category: 'conversation' }));
        const pc = svcConv.buildPlan(gc.id);
        expect(pc.handoff.contractVersion).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// PS61–PS66 — Correlation IDs across planning lifecycle
// ---------------------------------------------------------------------------

describe('PS61–PS66 — Correlation IDs across planning lifecycle', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS61 — registerGoal sets a correlationId on the goal', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        expect(g.correlationId).toBeTruthy();
        expect(g.correlationId).toMatch(/^corr-/);
    });

    it('PS62 — each registered goal gets a unique correlationId', () => {
        const svc = freshService();
        const g1 = svc.registerGoal(basicGoalInput());
        const g2 = svc.registerGoal(basicGoalInput());
        expect(g1.correlationId).not.toBe(g2.correlationId);
    });

    it('PS63 — correlationId is preserved across replan', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 5, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        // Goal should retain original correlationId after replan
        const updatedGoal = svc.getGoal(g.id);
        expect(updatedGoal?.correlationId).toBe(g.correlationId);
    });

    it('PS64 — planning.goal_registered event includes correlationId', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const payload = findEmittedPayload('planning.goal_registered');
        expect(payload?.correlationId).toBe(g.correlationId);
    });

    it('PS65 — planning.execution_handoff event includes correlationId', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.markExecutionStarted(plan.id);
        const payload = findEmittedPayload('planning.execution_handoff');
        expect(payload?.correlationId).toBe(g.correlationId);
    });

    it('PS66 — planning.replan_requested event includes correlationId', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 5, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        const plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const payload = findEmittedPayload('planning.replan_requested');
        expect(payload?.correlationId).toBe(g.correlationId);
    });
});

// ---------------------------------------------------------------------------
// PS67–PS72 — Replan guardrails
// ---------------------------------------------------------------------------

describe('PS67–PS72 — Replan guardrails', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS67 — can replan up to maxReplans without error', () => {
        const svc = freshService();
        const policy: ReplanPolicy = { maxReplans: 3, cooldownMs: 0 };
        svc.setReplanPolicy(policy);
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        for (let i = 0; i < 3; i++) {
            plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        }
        // Version 4 (initial + 3 replans)
        expect(plan.version).toBe(4);
    });

    it('PS68 — replan beyond maxReplans throws REPLAN_LIMIT_EXCEEDED', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 2, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const err = (() => {
            try {
                svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
                return null;
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(PlanningError);
        expect((err as PlanningError).code).toBe('REPLAN_LIMIT_EXCEEDED');
    });

    it('PS69 — replan within cooldown throws REPLAN_COOLDOWN_ACTIVE', () => {
        const svc = freshService();
        // 60 second cooldown — will trigger immediately on second call
        svc.setReplanPolicy({ maxReplans: 10, cooldownMs: 60_000 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        const err = (() => {
            try {
                svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
                return null;
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(PlanningError);
        expect((err as PlanningError).code).toBe('REPLAN_COOLDOWN_ACTIVE');
    });

    it('PS70 — replanCount on goal increments with each successful replan', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 5, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        expect(g.replanCount).toBe(0);
        let plan = svc.buildPlan(g.id);
        svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        expect(svc.getGoal(g.id)?.replanCount).toBe(1);
        const plans = svc.listPlansForGoal(g.id);
        const latest = plans[plans.length - 1];
        svc.replan({ goalId: g.id, priorPlanId: latest.id, trigger: 'manual' });
        expect(svc.getGoal(g.id)?.replanCount).toBe(2);
    });

    it('PS71 — setReplanPolicy configures custom maxReplans', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 1, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        // First replan succeeds; second exceeds limit
        expect(() =>
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' })
        ).toThrow(PlanningError);
    });

    it('PS72 — REPLAN_LIMIT_EXCEEDED error message includes the max limit', () => {
        const svc = freshService();
        svc.setReplanPolicy({ maxReplans: 1, cooldownMs: 0 });
        const g = svc.registerGoal(basicGoalInput());
        let plan = svc.buildPlan(g.id);
        plan = svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        let errMsg = '';
        try {
            svc.replan({ goalId: g.id, priorPlanId: plan.id, trigger: 'manual' });
        } catch (e) {
            errMsg = (e as Error).message;
        }
        expect(errMsg).toContain('1');
    });
});

// ---------------------------------------------------------------------------
// PS73–PS78 — Richer ApprovalContext model
// ---------------------------------------------------------------------------

describe('PS73–PS78 — Richer ApprovalContext model', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS73 — critical-priority plan has approvalContext populated', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.requiresApproval).toBe(true);
        expect(plan.approvalContext).toBeDefined();
        expect(plan.approvalContext?.triggeredBy.length).toBeGreaterThan(0);
        expect(plan.approvalContext?.reasons.length).toBeGreaterThan(0);
    });

    it('PS74 — approvalContext.riskLevel matches plan estimatedRisk', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.approvalContext?.riskLevel).toBe(plan.estimatedRisk);
    });

    it('PS75 — approvalContext.triggeredBy is a non-empty array for approval-required plan', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        expect(Array.isArray(plan.approvalContext?.triggeredBy)).toBe(true);
        expect((plan.approvalContext?.triggeredBy.length ?? 0)).toBeGreaterThan(0);
    });

    it('PS76 — normal-risk maintenance plan has no approvalContext', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'normal' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.requiresApproval).toBe(false);
        expect(plan.approvalContext).toBeUndefined();
    });

    it('PS77 — approvalContext.reasons is non-empty when approval required', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const plan = svc.buildPlan(g.id);
        const reasons = plan.approvalContext?.reasons ?? [];
        expect(reasons.length).toBeGreaterThan(0);
        for (const r of reasons) {
            expect(typeof r).toBe('string');
            expect(r.length).toBeGreaterThan(0);
        }
    });

    it('PS78 — GoalAnalysis includes approvalContext when approval is required', () => {
        const svc = freshService();
        const g = svc.registerGoal(basicGoalInput({ priority: 'critical' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.requiresApproval).toBe(true);
        expect(analysis.approvalContext).toBeDefined();
        expect(analysis.approvalContext?.triggeredBy).toContain('critical_risk');
    });
});

// ---------------------------------------------------------------------------
// PS79–PS83 — Non-manual capability provider
// ---------------------------------------------------------------------------

describe('PS79–PS83 — Non-manual capability provider', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('PS79 — registerCapabilityProvider is called during analyzeGoal', () => {
        const svc = freshService([]);
        const providerFn = vi.fn().mockReturnValue(new Set(['workflow_engine', 'memory_canonical']));
        svc.registerCapabilityProvider(providerFn);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        svc.analyzeGoal(g.id);
        expect(providerFn).toHaveBeenCalledTimes(1);
    });

    it('PS80 — provider-supplied capabilities take precedence over manually-set ones', () => {
        // Manually set = empty, provider returns full set
        const svc = freshService([]);
        svc.registerCapabilityProvider(() => new Set(['workflow_engine', 'memory_canonical']));
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.blockingIssues).toHaveLength(0);
        expect(analysis.missingCapabilities).toHaveLength(0);
    });

    it('PS81 — setAvailableCapabilities still works when no provider registered', () => {
        const svc = freshService(['workflow_engine', 'memory_canonical']);
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const analysis = svc.analyzeGoal(g.id);
        expect(analysis.blockingIssues).toHaveLength(0);
    });

    it('PS82 — provider is consulted on each analyzeGoal call independently', () => {
        const svc = freshService([]);
        let callCount = 0;
        svc.registerCapabilityProvider(() => {
            callCount++;
            return new Set(['workflow_engine', 'memory_canonical']);
        });
        const g1 = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const g2 = svc.registerGoal(basicGoalInput({ category: 'maintenance' }));
        svc.analyzeGoal(g1.id);
        svc.analyzeGoal(g2.id);
        expect(callCount).toBe(2);
    });

    it('PS83 — provider returning empty set causes missing-capability blocking', () => {
        const svc = freshService(['workflow_engine']);  // manual caps available
        // Provider overrides with empty
        svc.registerCapabilityProvider(() => new Set());
        const g = svc.registerGoal(basicGoalInput({ category: 'workflow' }));
        const plan = svc.buildPlan(g.id);
        expect(plan.status).toBe('blocked');
    });
});

// ---------------------------------------------------------------------------
// PS84–PS86 — IPC surface channel registration (static source scan)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPC_ROUTER_PATH = path.join(REPO_ROOT, 'electron/services/IpcRouter.ts');

/** Extract all ipcMain.handle channel names from a source file. */
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

describe('PS84–PS86 — IPC surface channel registration', () => {
    let channels: string[];

    beforeEach(() => {
        channels = extractIpcChannels(IPC_ROUTER_PATH);
    });

    it('PS84 — planning:getGoal and planning:getPlan are registered in IpcRouter.ts', () => {
        expect(channels).toContain('planning:getGoal');
        expect(channels).toContain('planning:getPlan');
    });

    it('PS85 — planning:listPlansForGoal and planning:buildPlan are registered in IpcRouter.ts', () => {
        expect(channels).toContain('planning:listPlansForGoal');
        expect(channels).toContain('planning:buildPlan');
    });

    it('PS86 — planning:approvePlan, planning:denyPlan, planning:markExecutionStarted, and planning:replan are registered', () => {
        expect(channels).toContain('planning:approvePlan');
        expect(channels).toContain('planning:denyPlan');
        expect(channels).toContain('planning:markExecutionStarted');
        expect(channels).toContain('planning:replan');
    });
});
