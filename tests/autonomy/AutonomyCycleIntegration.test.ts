import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutonomousRunOrchestrator } from '../../electron/services/autonomy/AutonomousRunOrchestrator';
import { DEFAULT_AUTONOMY_POLICY } from '../../electron/services/autonomy/defaults/defaultAutonomyPolicy';
import { TelemetryBus } from '../../electron/services/telemetry/TelemetryBus';
import { PolicyDeniedError } from '../../electron/services/policy/PolicyGate';
import { enforceSideEffectWithGuardrails } from '../../electron/services/policy/PolicyEnforcement';
import type { AutonomyPolicy } from '../../shared/autonomyTypes';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-autonomy-cycle-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

vi.mock('../../electron/services/policy/PolicyEnforcement', () => ({
    enforceSideEffectWithGuardrails: vi.fn().mockResolvedValue(undefined),
}));

type MockPlanner = ReturnType<typeof makeMockPlanner>;
type MockGovernance = ReturnType<typeof makeMockGovernance>;
type MockExecution = ReturnType<typeof makeMockExecution>;

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-autonomy-cycle-'));
}

function makeEnabledPolicy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
    return {
        ...DEFAULT_AUTONOMY_POLICY,
        globalAutonomyEnabled: true,
        categoryPolicies: DEFAULT_AUTONOMY_POLICY.categoryPolicies.map(cp => ({
            ...cp,
            autonomyEnabled: true,
        })),
        ...overrides,
    };
}

function makeMockPlanner(subsystemId = 'inference') {
    const proposal = {
        proposalId: `prop-${subsystemId}`,
        runId: `plan-${subsystemId}`,
        status: 'classified',
        targetSubsystem: subsystemId,
        targetFiles: [`electron/services/${subsystemId}/placeholder.ts`],
        title: `Repair ${subsystemId}`,
        verificationRequirements: {
            requiresBuild: false,
            requiresTypecheck: false,
            requiresLint: false,
            requiredTests: [],
            smokeChecks: [],
            manualReviewRequired: false,
            estimatedDurationMs: 1_000,
        },
        rollbackClassification: { rollbackSteps: ['noop'] },
        createdAt: new Date().toISOString(),
    };
    return {
        plan: vi.fn().mockResolvedValue({ runId: proposal.runId, status: 'running', message: 'ok' }),
        listProposals: vi.fn().mockReturnValue([proposal]),
        promoteProposal: vi.fn().mockReturnValue({ ...proposal, status: 'promoted' }),
        proposal,
    };
}

function makeMockGovernance() {
    return {
        evaluateForProposal: vi.fn().mockReturnValue({
            decisionId: 'gov-allow-1',
            status: 'self_authorized',
            executionAuthorized: true,
            executionAuthorizedAt: new Date().toISOString(),
            executionAuthorizedBy: 'autonomy_engine',
        }),
        getDecision: vi.fn().mockReturnValue(null),
        listDecisions: vi.fn().mockReturnValue([]),
    };
}

function makeMockExecution(subsystemId = 'inference') {
    return {
        start: vi.fn().mockResolvedValue({
            executionId: `exec-${subsystemId}`,
            status: 'validating',
            blocked: false,
            message: 'started',
        }),
        getRunStatus: vi.fn().mockReturnValue({
            executionId: `exec-${subsystemId}`,
            status: 'succeeded',
        }),
        listRecentRuns: vi.fn().mockReturnValue([
            {
                executionId: `seed-${subsystemId}`,
                subsystemId,
                status: 'failed_verification',
                startedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
            },
        ]),
    };
}

async function waitForRun(orchestrator: AutonomousRunOrchestrator, timeoutMs = 2_500) {
    const terminal = new Set([
        'succeeded',
        'failed',
        'rolled_back',
        'aborted',
        'governance_blocked',
        'policy_blocked',
        'budget_exhausted',
    ]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const runs = orchestrator.listRuns();
        if (runs.length > 0 && terminal.has(runs[0].status)) {
            return runs[0];
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for terminal autonomy run');
}

function buildOrchestrator(
    tmpDir: string,
    planner: MockPlanner,
    governance: MockGovernance,
    execution: MockExecution,
    policy = makeEnabledPolicy(),
) {
    const orchestrator = new AutonomousRunOrchestrator(
        tmpDir,
        planner as any,
        governance as any,
        execution as any,
        policy,
    );
    vi.spyOn(orchestrator as any, '_waitForExecution').mockResolvedValue('succeeded');
    return orchestrator;
}

describe('Autonomy Cycle Integration', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTempDir();
        vi.clearAllMocks();
        TelemetryBus._resetForTesting();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('normal autonomy cycle completes successfully with correct telemetry lifecycle', async () => {
        const planner = makeMockPlanner('inference');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);
        const busEvents: string[] = [];
        const unsub = TelemetryBus.getInstance().subscribe(evt => busEvents.push(evt.event));

        await orchestrator.runCycleOnce();
        const run = await waitForRun(orchestrator);

        expect(run.status).toBe('succeeded');
        expect(execution.start).toHaveBeenCalledTimes(1);
        expect(busEvents).toContain('execution.created');
        expect(busEvents).toContain('execution.accepted');
        expect(busEvents).toContain('execution.finalizing');
        expect(busEvents).toContain('execution.completed');
        unsub();
        orchestrator.stop();
    });

    it('cycle with no actionable goal exits cleanly', async () => {
        const planner = makeMockPlanner('inference');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        execution.listRecentRuns.mockReturnValue([]);
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();

        expect(orchestrator.listGoals()).toHaveLength(0);
        expect(orchestrator.listRuns()).toHaveLength(0);
        expect(planner.plan).not.toHaveBeenCalled();
        expect(execution.start).not.toHaveBeenCalled();
        orchestrator.stop();
    });

    it('required controlled execution step runs with canonical request contract', async () => {
        const planner = makeMockPlanner('memory');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('memory');
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        await waitForRun(orchestrator);

        expect(execution.start).toHaveBeenCalledWith({
            proposalId: planner.proposal.proposalId,
            authorizedBy: 'user_explicit',
            dryRun: false,
        });
        orchestrator.stop();
    });

    it('failed planning step emits explicit failure telemetry', async () => {
        const planner = makeMockPlanner('inference');
        planner.plan.mockResolvedValueOnce({ runId: 'plan-inference', status: 'failed', message: 'planner failed' });
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        const run = await waitForRun(orchestrator);
        const events = orchestrator.getDashboardState().recentTelemetry.map(e => e.type);

        expect(run.status).toBe('failed');
        expect(events).toContain('execution_failed');
        expect(execution.start).not.toHaveBeenCalled();
        orchestrator.stop();
    });

    it('policy blocks unsafe autonomy action before planning/execution', async () => {
        const planner = makeMockPlanner('inference');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        const policy = makeEnabledPolicy({
            categoryPolicies: makeEnabledPolicy().categoryPolicies.map(cp =>
                cp.categoryId === 'failed_verification'
                    ? { ...cp, autonomyEnabled: false }
                    : cp,
            ),
        });
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution, policy);

        await orchestrator.runCycleOnce();
        await new Promise(resolve => setTimeout(resolve, 50));
        const goals = orchestrator.listGoals();
        const selected = goals.find(g => g.source === 'failed_verification');

        expect(selected).toBeDefined();
        expect(selected!.status).toBe('policy_blocked');
        expect(planner.plan).not.toHaveBeenCalled();
        expect(execution.start).not.toHaveBeenCalled();
        orchestrator.stop();
    });

    it('retries inside autonomy remain bounded by current guardrail limits', async () => {
        const planner = makeMockPlanner('inference');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        execution.start.mockRejectedValue(new Error('execution start exploded'));
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        const run = await waitForRun(orchestrator);

        expect(run.status).toBe('aborted');
        expect(execution.start).toHaveBeenCalledTimes(1);
        orchestrator.stop();
    });

    it('overlapping cycle execution is rejected without corrupting state', async () => {
        const planner = makeMockPlanner('inference');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('inference');
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);
        (orchestrator as any)._cycleRunning = true;

        await orchestrator.runCycleOnce();

        expect(execution.listRecentRuns).not.toHaveBeenCalled();
        expect(orchestrator.listGoals()).toHaveLength(0);
        expect(orchestrator.listRuns()).toHaveLength(0);
        orchestrator.stop();
    });

    it('degraded subsystem availability causes explicit controlled degradation', async () => {
        const planner = makeMockPlanner('astro');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('astro');
        execution.start.mockResolvedValue({
            executionId: '',
            status: 'execution_blocked',
            blocked: true,
            message: 'astro subsystem unavailable',
        });
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        const run = await waitForRun(orchestrator);
        const telemetry = orchestrator.getDashboardState().recentTelemetry;

        expect(run.status).toBe('failed');
        expect(run.failureReason).toContain('Execution blocked');
        expect(telemetry.some(e => e.type === 'execution_failed' && e.detail.includes('astro subsystem unavailable'))).toBe(true);
        orchestrator.stop();
    });

    it('inference autonomy cycle supports controlled completion and controlled degradation', async () => {
        const plannerA = makeMockPlanner('inference');
        const governanceA = makeMockGovernance();
        const executionA = makeMockExecution('inference');
        const orchestratorA = buildOrchestrator(tmpDir, plannerA, governanceA, executionA);
        await orchestratorA.runCycleOnce();
        const runA = await waitForRun(orchestratorA);
        expect(runA.status).toBe('succeeded');
        orchestratorA.stop();

        const tmpDirB = makeTempDir();
        try {
            const plannerB = makeMockPlanner('inference');
            const governanceB = makeMockGovernance();
            const executionB = makeMockExecution('inference');
            executionB.start.mockResolvedValue({
                executionId: '',
                status: 'execution_blocked',
                blocked: true,
                message: 'all inference providers unavailable',
            });
            const orchestratorB = buildOrchestrator(tmpDirB, plannerB, governanceB, executionB);
            await orchestratorB.runCycleOnce();
            const runB = await waitForRun(orchestratorB);
            expect(runB.status).toBe('failed');
            expect(runB.failureReason).toContain('all inference providers unavailable');
            orchestratorB.stop();
        } finally {
            fs.rmSync(tmpDirB, { recursive: true, force: true });
        }
    });

    it('governance/policy can forbid proposal apply and keep blocked actions blocked', async () => {
        const planner = makeMockPlanner('repair');
        const governance = makeMockGovernance();
        governance.evaluateForProposal.mockReturnValueOnce({
            decisionId: 'gov-block-1',
            status: 'blocked',
            executionAuthorized: false,
            blockReason: 'manual approval required',
        });
        const execution = makeMockExecution('repair');
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        const run = await waitForRun(orchestrator);

        expect(run.status).toBe('governance_blocked');
        expect(execution.start).not.toHaveBeenCalled();
        expect(orchestrator.listGoals().some(g => g.status === 'governance_blocked')).toBe(true);
        orchestrator.stop();
    });

    it('policy-denied pre-execution side effect remains blocked and does not execute downstream', async () => {
        const planner = makeMockPlanner('memory');
        const governance = makeMockGovernance();
        const execution = makeMockExecution('memory');
        (enforceSideEffectWithGuardrails as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new PolicyDeniedError('Autonomy policy denied pre-execution side effect'),
        );
        const orchestrator = buildOrchestrator(tmpDir, planner, governance, execution);

        await orchestrator.runCycleOnce();
        await new Promise(resolve => setTimeout(resolve, 100));
        const busEvents = TelemetryBus.getInstance().getRecentEvents().map(e => e.event);

        expect(execution.start).not.toHaveBeenCalled();
        expect(busEvents).toContain('execution.failed');
        orchestrator.stop();
    });
});
