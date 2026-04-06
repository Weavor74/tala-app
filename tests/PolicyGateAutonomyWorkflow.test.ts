/**
 * PolicyGateAutonomyWorkflow.test.ts
 *
 * Integration tests for PolicyGate enforcement in the autonomy and workflow paths.
 *
 * Validates that policyGate.assertSideEffect() is called before any side-effecting
 * operation in:
 *   1. AutonomousRunOrchestrator._executeGoalPipeline() — before executionOrchestrator.start()
 *   2. WorkflowEngine.executeWorkflow()                 — before each node execution
 *
 * PAW1   AutonomousRunOrchestrator calls assertSideEffect with actionKind='autonomy_action'
 * PAW2   assertSideEffect receives correct executionType, origin, mode for autonomy
 * PAW3   assertSideEffect receives the runId as executionId
 * PAW4   assertSideEffect receives targetSubsystem='autonomy' and mutationIntent='execute'
 * PAW5   Blocked autonomy action throws PolicyDeniedError
 * PAW6   Blocked autonomy action does NOT call executionOrchestrator.start()
 * PAW7   PolicyDeniedError propagates correctly from the autonomy pipeline
 * PAW8   WorkflowEngine calls assertSideEffect with actionKind='workflow_action'
 * PAW9   assertSideEffect receives targetSubsystem='workflow'
 * PAW10  assertSideEffect is called once per node executed in the workflow
 * PAW11  Blocked workflow step throws PolicyDeniedError (executeWorkflow rejects)
 * PAW12  Blocked workflow step prevents node execution
 * PAW13  PolicyDeniedError propagates correctly from executeWorkflow()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { policyGate, PolicyDeniedError } from '../electron/services/policy/PolicyGate';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-policy-aw-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: { operational: vi.fn(), event: vi.fn() },
}));

vi.mock('imapflow', () => ({}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { AutonomousRunOrchestrator } from '../electron/services/autonomy/AutonomousRunOrchestrator';
import { WorkflowEngine } from '../electron/services/WorkflowEngine';
import { DEFAULT_AUTONOMY_POLICY } from '../electron/services/autonomy/defaults/defaultAutonomyPolicy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-paw-test-'));
}

function makeBlockDecision() {
    return { allowed: false, reason: 'blocked by test rule', code: 'TEST_POLICY_BLOCK' };
}

/** Minimal AutonomousGoal fixture */
function makeGoal(overrides: Record<string, unknown> = {}): any {
    return {
        goalId: 'goal-paw-001',
        candidateId: 'cand-paw-001',
        title: 'Test goal',
        description: 'Policy gate test goal',
        subsystemId: 'inference',
        dedupFingerprint: 'fp-paw-001',
        sourceContext: { kind: 'repeated_execution_failure', failureCount: 1, periodMs: 1000, lastExecutionRunId: 'exec-0' },
        source: 'repeated_execution_failure',
        status: 'queued',
        priority: 'high',
        priorityScore: 0.9,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

/** Minimal mock planner that produces a ready proposal */
function makeMockPlanner(proposalId = 'prop-paw-001') {
    return {
        plan: vi.fn().mockResolvedValue({ status: 'completed', runId: 'plan-run-paw-001', message: '' }),
        listProposals: vi.fn().mockReturnValue([{
            proposalId,
            runId: 'plan-run-paw-001',
            status: 'approved',
        }]),
        promoteProposal: vi.fn().mockReturnValue(true),
    };
}

/** Minimal mock governance that immediately self-authorizes */
function makeMockGovernance(proposalId = 'prop-paw-001') {
    return {
        evaluateForProposal: vi.fn().mockReturnValue({
            decisionId: 'dec-paw-001',
            proposalId,
            status: 'self_authorized',
            executionAuthorized: true,
            executionAuthorizedAt: new Date().toISOString(),
            executionAuthorizedBy: 'autonomy_engine',
        }),
        getDecision: vi.fn().mockReturnValue(null),
        listDecisions: vi.fn().mockReturnValue([]),
    };
}

/** Minimal mock execution orchestrator */
function makeMockExecution() {
    return {
        start: vi.fn().mockResolvedValue({ blocked: false, executionId: 'exec-run-paw-001' }),
        getRunStatus: vi.fn().mockReturnValue('completed'),
        listRecentRuns: vi.fn().mockReturnValue([]),
    };
}

/** Minimal single-node workflow (no edges needed for a single-start node) */
function makeSingleNodeWorkflow(nodeType = 'start') {
    return {
        nodes: [{ id: 'node-1', type: nodeType, data: {}, position: { x: 0, y: 0 } }],
        edges: [],
    };
}

// ─── PAW1–PAW7: AutonomousRunOrchestrator autonomy_action enforcement ─────────

describe('PAW1–PAW7: AutonomousRunOrchestrator._executeGoalPipeline() — PolicyGate enforcement', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function buildOrchestrator(overrides: { execution?: ReturnType<typeof makeMockExecution> } = {}) {
        const mockExecution = overrides.execution ?? makeMockExecution();
        const orch = new AutonomousRunOrchestrator(
            tmpDir,
            makeMockPlanner() as any,
            makeMockGovernance() as any,
            mockExecution as any,
            { ...DEFAULT_AUTONOMY_POLICY, globalAutonomyEnabled: true },
        );
        orch.stop(); // prevent background cycle
        return { orch, mockExecution };
    }

    /** Register the goal in the orchestrator's activeGoals map so finally block works. */
    function registerGoal(orch: AutonomousRunOrchestrator, goal: ReturnType<typeof makeGoal>) {
        (orch as any).activeGoals.set(goal.goalId, goal);
    }

    it('PAW1: calls assertSideEffect with actionKind=autonomy_action', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(orch as any, '_waitForExecution').mockResolvedValue('succeeded');
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await (orch as any)._executeGoalPipeline(goal, 'pd-001');

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'autonomy_action' }),
        );
    });

    it('PAW2: assertSideEffect receives correct executionType, origin, mode', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(orch as any, '_waitForExecution').mockResolvedValue('succeeded');
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await (orch as any)._executeGoalPipeline(goal, 'pd-002');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionType).toBe('autonomy_task');
        expect(ctx.executionOrigin).toBe('autonomy_engine');
        expect(ctx.executionMode).toBe('system');
    });

    it('PAW3: assertSideEffect receives the run runId as executionId', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(orch as any, '_waitForExecution').mockResolvedValue('succeeded');
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await (orch as any)._executeGoalPipeline(goal, 'pd-003');

        const ctx = spy.mock.calls[0][0];
        expect(typeof ctx.executionId).toBe('string');
        expect(ctx.executionId!.length).toBeGreaterThan(0);
    });

    it('PAW4: assertSideEffect receives targetSubsystem=autonomy and mutationIntent=execute', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(orch as any, '_waitForExecution').mockResolvedValue('succeeded');
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await (orch as any)._executeGoalPipeline(goal, 'pd-004');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('autonomy');
        expect(ctx.mutationIntent).toBe('execute');
    });

    it('PAW5: blocked autonomy action throws PolicyDeniedError', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        await expect(
            (orch as any)._executeGoalPipeline(goal, 'pd-005'),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('PAW6: blocked autonomy action does NOT call executionOrchestrator.start()', async () => {
        const mockExecution = makeMockExecution();
        const { orch } = buildOrchestrator({ execution: mockExecution });
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        try {
            await (orch as any)._executeGoalPipeline(goal, 'pd-006');
        } catch (_) {
            // expected
        }

        expect(mockExecution.start).not.toHaveBeenCalled();
    });

    it('PAW7: PolicyDeniedError propagates with correct code', async () => {
        const { orch } = buildOrchestrator();
        const goal = makeGoal();
        registerGoal(orch, goal);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        let caught: unknown;
        try {
            await (orch as any)._executeGoalPipeline(goal, 'pd-007');
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyDeniedError);
        expect((caught as PolicyDeniedError).decision.code).toBe('TEST_POLICY_BLOCK');
    });
});

// ─── PAW8–PAW13: WorkflowEngine workflow_action enforcement ──────────────────

describe('PAW8–PAW13: WorkflowEngine.executeWorkflow() — PolicyGate enforcement', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function buildEngine() {
        const mockFunctionService = { call: vi.fn().mockResolvedValue('fn-result') } as any;
        const mockAgentService = { chat: vi.fn().mockResolvedValue({ reply: 'ok' }) } as any;
        return new WorkflowEngine(mockFunctionService, mockAgentService);
    }

    it('PAW8: calls assertSideEffect with actionKind=workflow_action', async () => {
        const engine = buildEngine();
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await engine.executeWorkflow(makeSingleNodeWorkflow('start'));

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'workflow_action' }),
        );
    });

    it('PAW9: assertSideEffect receives targetSubsystem=workflow', async () => {
        const engine = buildEngine();
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await engine.executeWorkflow(makeSingleNodeWorkflow('start'));

        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('workflow');
    });

    it('PAW10: assertSideEffect is called once per node executed in a two-node workflow', async () => {
        const engine = buildEngine();
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        const workflow = {
            nodes: [
                { id: 'n1', type: 'start', data: {}, position: { x: 0, y: 0 } },
                { id: 'n2', type: 'merge', data: {}, position: { x: 100, y: 0 } },
            ],
            edges: [
                { id: 'e1', source: 'n1', target: 'n2' },
            ],
        };
        await engine.executeWorkflow(workflow);

        const workflowCalls = spy.mock.calls.filter(c => c[0].actionKind === 'workflow_action');
        expect(workflowCalls.length).toBe(2);
    });

    it('PAW11: blocked workflow step causes executeWorkflow() to reject with PolicyDeniedError', async () => {
        const engine = buildEngine();
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start')),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('PAW12: blocked workflow step prevents executeNode from being called', async () => {
        const engine = buildEngine();
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        // Spy on private executeNode to confirm it's not reached
        const executeNodeSpy = vi.spyOn(engine as any, 'executeNode');

        try {
            await engine.executeWorkflow(makeSingleNodeWorkflow('start'));
        } catch (_) {
            // expected
        }

        expect(executeNodeSpy).not.toHaveBeenCalled();
    });

    it('PAW13: PolicyDeniedError propagates with correct decision from executeWorkflow', async () => {
        const engine = buildEngine();
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        let caught: unknown;
        try {
            await engine.executeWorkflow(makeSingleNodeWorkflow('start'));
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.code).toBe('TEST_POLICY_BLOCK');
        expect(denied.decision.reason).toContain('blocked by test rule');
    });
});
