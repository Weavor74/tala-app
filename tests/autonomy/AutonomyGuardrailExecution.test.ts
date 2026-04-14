import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutonomousRunOrchestrator } from '../../electron/services/autonomy/AutonomousRunOrchestrator';
import { DEFAULT_AUTONOMY_POLICY } from '../../electron/services/autonomy/defaults/defaultAutonomyPolicy';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-autonomy-guardrail-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: { operational: vi.fn(), event: vi.fn() },
}));

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-autonomy-guardrails-'));
}

function makeGoal() {
    return {
        goalId: 'goal-guardrail-1',
        title: 'Guardrail test goal',
        description: 'test',
        subsystemId: 'inference',
        dedupFingerprint: 'fp-guardrail-1',
        source: 'repeated_execution_failure',
        sourceContext: { kind: 'generic', detail: 'test' },
        status: 'queued',
        priorityTier: 'high',
        priorityScore: {
            total: 80,
            severityWeight: 10,
            recurrenceWeight: 10,
            subsystemImportanceWeight: 10,
            confidenceWeight: 10,
            governanceLikelihoodWeight: 10,
            rollbackConfidenceWeight: 10,
            executionCostPenalty: 0,
            protectedPenalty: 0,
        },
        autonomyEligible: true,
        attemptCount: 0,
        humanReviewRequired: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    } as any;
}

function makePlanner(proposalId = 'proposal-1') {
    return {
        plan: vi.fn().mockResolvedValue({ status: 'completed', runId: 'plan-run-1', message: '' }),
        listProposals: vi.fn().mockReturnValue([{ proposalId, runId: 'plan-run-1', status: 'approved', targetSubsystem: 'inference', targetFiles: [] }]),
        promoteProposal: vi.fn().mockReturnValue(true),
    } as any;
}

function makeGovernance(proposalId = 'proposal-1') {
    return {
        evaluateForProposal: vi.fn().mockReturnValue({
            decisionId: 'gov-1',
            proposalId,
            status: 'self_authorized',
            executionAuthorized: true,
            executionAuthorizedAt: new Date().toISOString(),
            executionAuthorizedBy: 'autonomy_engine',
        }),
        getDecision: vi.fn().mockReturnValue(null),
        listDecisions: vi.fn().mockReturnValue([]),
    } as any;
}

describe('AutonomousRunOrchestrator guardrail execution pipeline', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not rerun execution start after start() succeeds', async () => {
        const execution = {
            start: vi.fn().mockResolvedValue({ blocked: false, executionId: 'exec-1' }),
            getRunStatus: vi.fn().mockReturnValue({ status: 'running' }),
            listRecentRuns: vi.fn().mockReturnValue([]),
        } as any;
        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir,
            makePlanner(),
            makeGovernance(),
            execution,
            { ...DEFAULT_AUTONOMY_POLICY, globalAutonomyEnabled: true },
        );
        orchestrator.stop();
        const goal = makeGoal();
        (orchestrator as any).activeGoals.set(goal.goalId, goal);
        vi.spyOn(orchestrator as any, '_waitForExecution').mockRejectedValue(new Error('poll failure'));

        await (orchestrator as any)._executeGoalPipeline(goal, 'policy-1');

        expect(execution.start).toHaveBeenCalledTimes(1);
    });

    it('does not retry execution start when start() throws', async () => {
        const execution = {
            start: vi.fn().mockRejectedValue(new Error('start exploded')),
            getRunStatus: vi.fn(),
            listRecentRuns: vi.fn().mockReturnValue([]),
        } as any;
        const orchestrator = new AutonomousRunOrchestrator(
            tmpDir,
            makePlanner(),
            makeGovernance(),
            execution,
            { ...DEFAULT_AUTONOMY_POLICY, globalAutonomyEnabled: true },
        );
        orchestrator.stop();
        const goal = makeGoal();
        (orchestrator as any).activeGoals.set(goal.goalId, goal);

        await (orchestrator as any)._executeGoalPipeline(goal, 'policy-2');

        expect(execution.start).toHaveBeenCalledTimes(1);
    });
});

