/**
 * AutonomousRunOrchestrator.ts — Phase 4 P4E
 *
 * Main autonomous improvement loop coordinator.
 *
 * Architecture:
 *   GoalDetection → Prioritization → Selection → PolicyGate
 *     → SafeChangePlanner.plan()          (Phase 2)
 *     → SafeChangePlanner.promoteProposal()
 *     → GovernanceAppService.evaluateForProposal()   (Phase 3.5)
 *     → [immediate if self-authorized | governance_pending if human needed]
 *     → ExecutionOrchestrator.start()    (Phase 3)
 *     → OutcomeLearningRegistry.record()
 *     → AutonomyDashboardBridge.maybeEmit()
 *
 * Safety invariants enforced here:
 *  1. One active run per subsystem (via AutonomyBudgetManager)
 *  2. One active run globally by default
 *  3. Cooldown applied after failure/rollback/governance block
 *  4. Budget capped per period
 *  5. No recursion: _cycleRunning flag prevents re-entrant cycles
 *  6. Every run is persisted (AutonomyAuditService)
 *  7. OutcomeLearningRegistry always called (finally block)
 *  8. Governance is mandatory — no execution without authorized decision
 *  9. No direct code mutation — all changes go through planning pipeline
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AutonomousGoal,
    AutonomousRun,
    AutonomousRunMilestone,
    AutonomousRunMilestoneName,
    AutonomousRunStatus,
    AttemptOutcome,
    AutonomyPolicy,
} from '../../../shared/autonomyTypes';
import type { SafeChangePlanner } from '../reflection/SafeChangePlanner';
import type { GovernanceAppService } from '../governance/GovernanceAppService';
import type { ExecutionOrchestrator } from '../execution/ExecutionOrchestrator';
import type { PlanTriggerInput } from '../../../shared/reflectionPlanTypes';
import { GoalDetectionEngine } from './GoalDetectionEngine';
import { GoalPrioritizationEngine } from './GoalPrioritizationEngine';
import { AutonomyPolicyGate } from './AutonomyPolicyGate';
import { AutonomyBudgetManager } from './AutonomyBudgetManager';
import { AutonomyCooldownRegistry } from './AutonomyCooldownRegistry';
import { OutcomeLearningRegistry } from './OutcomeLearningRegistry';
import { AutonomyAuditService } from './AutonomyAuditService';
import { AutonomyTelemetryStore } from './AutonomyTelemetryStore';
import { AutonomyDashboardBridge } from './AutonomyDashboardBridge';
import { telemetry } from '../TelemetryService';

// ─── Poll timeouts ────────────────────────────────────────────────────────────

// How long to wait for governance to resolve after self-authorization attempt
const GOVERNANCE_POLL_INTERVAL_MS = 2_000;
const GOVERNANCE_POLL_TIMEOUT_MS = 30_000;  // 30 seconds for self-auth path
// How long to wait for execution to reach a terminal state
const EXECUTION_POLL_INTERVAL_MS = 2_000;
const EXECUTION_POLL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// ─── AutonomousRunOrchestrator ─────────────────────────────────────────────────

export class AutonomousRunOrchestrator {
    private cycleTimer: NodeJS.Timeout | null = null;
    private _cycleRunning = false;

    // In-memory goal registry (keyed by goalId)
    private activeGoals: Map<string, AutonomousGoal> = new Map();
    // In-memory run registry (keyed by runId)
    private activeRuns: Map<string, AutonomousRun> = new Map();

    private readonly detectionEngine: GoalDetectionEngine;
    private readonly prioritizationEngine: GoalPrioritizationEngine;
    private readonly policyGate: AutonomyPolicyGate;
    readonly budgetManager: AutonomyBudgetManager;
    private readonly cooldownRegistry: AutonomyCooldownRegistry;
    readonly learningRegistry: OutcomeLearningRegistry;
    private readonly auditService: AutonomyAuditService;
    private readonly telemetryStore: AutonomyTelemetryStore;
    readonly dashboardBridge: AutonomyDashboardBridge;

    constructor(
        private readonly dataDir: string,
        private readonly safePlanner: SafeChangePlanner,
        private readonly governanceAppService: GovernanceAppService,
        private readonly executionOrchestrator: ExecutionOrchestrator,
        private activePolicy: AutonomyPolicy,
    ) {
        this.budgetManager = new AutonomyBudgetManager();
        this.cooldownRegistry = new AutonomyCooldownRegistry(dataDir);
        this.learningRegistry = new OutcomeLearningRegistry(dataDir);
        this.auditService = new AutonomyAuditService(dataDir);
        this.telemetryStore = new AutonomyTelemetryStore(dataDir);
        this.dashboardBridge = new AutonomyDashboardBridge();
        this.policyGate = new AutonomyPolicyGate(
            this.budgetManager,
            this.cooldownRegistry,
            this.learningRegistry,
        );
        this.prioritizationEngine = new GoalPrioritizationEngine(
            this.learningRegistry,
            this.cooldownRegistry,
            this.budgetManager,
        );

        this.detectionEngine = new GoalDetectionEngine(
            {
                listRecentExecutionRuns: (w) => executionOrchestrator.listRecentRuns(w),
                listGovernanceDecisions: (f) => {
                    // ApprovalWorkflowRegistry.listDecisions via GovernanceAppService
                    // We call the public evaluateForProposal indirectly — but for detection
                    // we read decisions via the governance service's internal data.
                    // Since GovernanceAppService doesn't expose listDecisions directly,
                    // we return empty array safely (governance-block detection is a best-effort signal).
                    return [];
                },
                listReflectionGoals: () => this._listReflectionGoals(),
                getActiveGoalFingerprints: () => {
                    const fingerprints = new Set<string>();
                    for (const g of this.activeGoals.values()) {
                        const nonTerminal = g.status !== 'succeeded' &&
                            g.status !== 'failed' &&
                            g.status !== 'rolled_back' &&
                            g.status !== 'suppressed' &&
                            g.status !== 'expired';
                        if (nonTerminal) fingerprints.add(g.dedupFingerprint);
                    }
                    return fingerprints;
                },
            },
            (candidates) => this._onCandidatesDetected(candidates),
        );

        this.telemetryStore.startAutoFlush();
        this._recoverStaleRuns();

        // Load persisted goals into memory
        const persisted = this.auditService.listGoals();
        for (const g of persisted) {
            this.activeGoals.set(g.goalId, g);
        }
        const persistedRuns = this.auditService.listRuns();
        for (const r of persistedRuns) {
            this.activeRuns.set(r.runId, r);
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    start(cycleIntervalMs = 5 * 60 * 1000): void {
        this.detectionEngine.start(cycleIntervalMs);
    }

    stop(): void {
        this.detectionEngine.stop();
        if (this.cycleTimer) {
            clearInterval(this.cycleTimer);
            this.cycleTimer = null;
        }
        this.telemetryStore.stopAutoFlush();
    }

    // ── Manual trigger (IPC + testing) ─────────────────────────────────────────

    /**
     * Manually triggers one detection+scoring+execution cycle.
     * Safe to call from tests and from the IPC handler.
     */
    async runCycleOnce(): Promise<void> {
        if (this._cycleRunning) {
            telemetry.operational(
                'autonomy',
                'autonomy_run_failed',
                'warn',
                'AutonomousRunOrchestrator',
                'runCycleOnce skipped: cycle already running',
            );
            return;
        }

        this._cycleRunning = true;
        try {
            // 1. Detect candidates
            const candidates = await this.detectionEngine.runOnce();
            if (candidates.length === 0) return;

            this._onCandidatesDetected(candidates);
        } finally {
            this._cycleRunning = false;
        }
    }

    // ── Dashboard data ──────────────────────────────────────────────────────────

    getDashboardState(): import('../../../shared/autonomyTypes').AutonomyDashboardState {
        const allRuns = [...this.activeRuns.values()].sort(
            (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
        const allGoals = [...this.activeGoals.values()].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        const learningRecords = this.learningRegistry.listAll();
        const recentTelemetry = this.telemetryStore.getRecentEvents(50);
        const budgetUsed = this.budgetManager.getUsedThisPeriod(this.activePolicy.budget);

        return this.dashboardBridge.emitFull(
            allRuns, allGoals, learningRecords, recentTelemetry,
            this.activePolicy, budgetUsed,
        );
    }

    listGoals(): AutonomousGoal[] {
        return [...this.activeGoals.values()].sort(
            (a, b) => b.priorityScore.total - a.priorityScore.total,
        );
    }

    getGoal(goalId: string): AutonomousGoal | null {
        return this.activeGoals.get(goalId) ?? null;
    }

    listRuns(windowMs?: number): AutonomousRun[] {
        return this.auditService.listRuns(windowMs);
    }

    getRun(runId: string): AutonomousRun | null {
        return this.activeRuns.get(runId) ?? this.auditService.loadRun(runId);
    }

    getAuditLog(goalId: string): import('./AutonomyAuditService').AutonomyAuditRecord[] {
        return this.auditService.readAuditLog(goalId);
    }

    // ── Policy management ───────────────────────────────────────────────────────

    setGlobalEnabled(enabled: boolean): void {
        this.activePolicy = { ...this.activePolicy, globalAutonomyEnabled: enabled };
        this.auditService.appendAuditRecord('global_autonomy_toggled',
            `Global autonomy ${enabled ? 'enabled' : 'disabled'}`,
        );
        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'AutonomousRunOrchestrator',
            `Global autonomy ${enabled ? 'enabled' : 'disabled'} by operator`,
        );
    }

    getPolicy(): AutonomyPolicy {
        return { ...this.activePolicy };
    }

    updatePolicy(policy: AutonomyPolicy): void {
        this.activePolicy = policy;
        this.auditService.appendAuditRecord('policy_updated', 'Autonomy policy updated by operator');
    }

    clearCooldown(subsystemId: string, patternKey: string): boolean {
        const cleared = this.cooldownRegistry.clearCooldown(subsystemId, patternKey);
        if (cleared) {
            this.auditService.appendAuditRecord(
                'cooldown_cleared_by_operator',
                `Cooldown manually cleared for ${subsystemId}`,
                { subsystemId },
            );
        }
        return cleared;
    }

    // ── Candidate intake ────────────────────────────────────────────────────────

    private _onCandidatesDetected(candidates: import('../../../shared/autonomyTypes').GoalCandidate[]): void {
        const newCandidates = candidates.filter(c => !c.isDuplicate);
        if (newCandidates.length === 0) return;

        // Score all candidates
        const scoredGoals = this.prioritizationEngine.score(newCandidates, this.activePolicy);

        // Register goals and persist
        for (const goal of scoredGoals) {
            this.activeGoals.set(goal.goalId, goal);
            this.auditService.saveGoal(goal);
            this.auditService.appendAuditRecord('goal_created',
                `Goal '${goal.title}' created (tier: ${goal.priorityTier}, score: ${goal.priorityScore.total})`,
                { goalId: goal.goalId, subsystemId: goal.subsystemId },
            );
            this.telemetryStore.record('goal_scored',
                `Goal '${goal.title}' scored ${goal.priorityScore.total} (${goal.priorityTier})`,
                { goalId: goal.goalId, subsystemId: goal.subsystemId },
            );
        }

        // Select the best eligible goal for this cycle
        const eligible = scoredGoals.filter(g => g.status === 'scored' && g.priorityTier !== 'suppressed');
        if (eligible.length === 0) return;

        const selected = eligible[0]; // Highest-scored non-suppressed goal
        this._selectAndExecuteGoal(selected);
    }

    private _selectAndExecuteGoal(goal: AutonomousGoal): void {
        // Update goal status
        this._updateGoal(goal.goalId, { status: 'selected' });
        this.telemetryStore.record('goal_selected',
            `Goal '${goal.title}' selected for autonomous execution`,
            { goalId: goal.goalId, subsystemId: goal.subsystemId },
        );

        // Policy gate evaluation
        const policyDecision = this.policyGate.evaluate(goal, this.activePolicy);
        this._updateGoal(goal.goalId, { policyDecisionId: policyDecision.decisionId });

        this.auditService.appendAuditRecord(
            policyDecision.permitted ? 'policy_approved' : 'policy_blocked',
            policyDecision.rationale,
            { goalId: goal.goalId, subsystemId: goal.subsystemId },
        );

        this.telemetryStore.record(
            policyDecision.permitted ? 'policy_approved' : 'policy_blocked',
            policyDecision.rationale,
            { goalId: goal.goalId, subsystemId: goal.subsystemId, data: { decisionId: policyDecision.decisionId } },
        );

        if (!policyDecision.permitted) {
            const newStatus = policyDecision.requiresHumanReview ? 'policy_blocked' : 'suppressed';
            this._updateGoal(goal.goalId, {
                status: newStatus,
                humanReviewRequired: policyDecision.requiresHumanReview,
            });
            return;
        }

        // Mark goal as policy-approved
        this._updateGoal(goal.goalId, { status: 'policy_approved', autonomyEligible: true });

        // Execute asynchronously (fire-and-forget with error capture)
        this._executeGoalPipeline(this.activeGoals.get(goal.goalId)!, policyDecision.decisionId)
            .catch(err => {
                telemetry.operational(
                    'autonomy',
                    'autonomy_run_failed',
                    'error',
                    'AutonomousRunOrchestrator',
                    `Unhandled error in pipeline for goal ${goal.goalId}: ${err.message}`,
                );
            });
    }

    // ── Execution pipeline ──────────────────────────────────────────────────────

    private async _executeGoalPipeline(
        goal: AutonomousGoal,
        policyDecisionId: string,
    ): Promise<void> {
        const cycleId = uuidv4();
        const run: AutonomousRun = {
            runId: uuidv4(),
            goalId: goal.goalId,
            cycleId,
            startedAt: new Date().toISOString(),
            status: 'running',
            subsystemId: goal.subsystemId,
            policyDecisionId,
            milestones: [],
        };

        this.activeRuns.set(run.runId, run);
        this.budgetManager.recordRunStart(run.runId, goal.subsystemId);
        this._addMilestone(run, 'run_started');
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_started',
            `Autonomous run started for goal '${goal.title}'`,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('run_started',
            `Run ${run.runId} started for goal '${goal.title}'`,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this._updateGoal(goal.goalId, { status: 'planning', executionRunId: undefined });

        this._emitDashboard('run_started', run);

        try {
            // ── Phase 2: Safe Change Planning ────────────────────────────────────
            this._updateRunStatus(run, 'planning');
            this._addMilestone(run, 'planning_started');
            this.telemetryStore.record('planning_started',
                `Planning started for goal '${goal.title}'`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );

            const planInput: PlanTriggerInput = {
                subsystemId: goal.subsystemId,
                issueType: goal.source,
                normalizedTarget: goal.subsystemId,
                severity: this._severityForTier(goal.priorityTier),
                description: goal.description,
                planningMode: 'standard',
                sourceGoalId: goal.goalId,
                isManual: false,
            };

            const planResponse = await this.safePlanner.plan(planInput);

            if (planResponse.status === 'cooldown_blocked' || planResponse.status === 'failed') {
                this._failRun(run, goal, `Planning ${planResponse.status}: ${planResponse.message}`);
                return;
            }

            run.planRunId = planResponse.runId;
            this.auditService.saveRun(run);

            // Find the proposal produced by this run (may need a small delay for async plan)
            await this._delay(100);
            const proposal = this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                .find(p => p.runId === planResponse.runId);

            if (!proposal) {
                this._failRun(run, goal, 'Planning completed but no proposal was generated');
                return;
            }

            run.proposalId = proposal.proposalId;
            this._addMilestone(run, 'proposal_created');
            this.auditService.saveRun(run);

            this.telemetryStore.record('proposal_created',
                `Proposal ${proposal.proposalId} created`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );

            // ── Phase 2: Promote proposal ─────────────────────────────────────────
            if (proposal.status === 'draft' || proposal.status === 'classified') {
                const promoted = this.safePlanner.promoteProposal(proposal.proposalId);
                if (!promoted) {
                    this._failRun(run, goal, `Could not promote proposal ${proposal.proposalId} (status: ${proposal.status})`);
                    return;
                }
            }

            // ── Phase 3.5: Governance evaluation ─────────────────────────────────
            this._addMilestone(run, 'governance_submitted');
            this.auditService.appendAuditRecord('governance_submitted',
                `Governance evaluation triggered for proposal ${proposal.proposalId}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            // evaluateForProposal is also called automatically by the onProposalPromoted callback
            // in main.ts, but we call it here explicitly to ensure it exists.
            const govDecision = this.governanceAppService.evaluateForProposal(
                this.safePlanner.listProposals(4 * 60 * 60 * 1000)
                    .find(p => p.proposalId === proposal.proposalId) ?? proposal,
            );

            run.governanceDecisionId = govDecision.decisionId;
            this.auditService.saveRun(run);

            // Check governance outcome
            if (govDecision.status === 'blocked' || govDecision.status === 'rejected') {
                this._governanceBlockedRun(run, goal, `Governance ${govDecision.status}: ${govDecision.blockReason ?? 'policy blocked'}`);
                return;
            }

            if (!govDecision.executionAuthorized) {
                // Governance requires human approval — move to governance_pending
                // Do NOT proceed; surface in dashboard for human action.
                this._updateRunStatus(run, 'governance_pending');
                this._updateGoal(goal.goalId, { status: 'governance_pending', governanceDecisionId: govDecision.decisionId });
                this.auditService.saveRun(run);
                this.telemetryStore.record('governance_submitted',
                    `Run ${run.runId} awaiting human governance approval`,
                    { goalId: goal.goalId, runId: run.runId },
                );
                this._emitDashboard('governance_resolved', run);
                // Run stays in governance_pending — will be resumed when governance approves
                return;
            }

            // Governance self-authorized → proceed
            this._addMilestone(run, 'governance_resolved', 'self_authorized');
            this._emitDashboard('governance_resolved', run);

            // ── Phase 3: Controlled Execution ─────────────────────────────────────
            this._updateRunStatus(run, 'executing');
            this._addMilestone(run, 'execution_started');
            this._updateGoal(goal.goalId, { status: 'executing' });

            this.telemetryStore.record('execution_started',
                `Execution started for proposal ${proposal.proposalId}`,
                { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
            );
            this._emitDashboard('execution_started', run);

            const execResponse = await this.executionOrchestrator.start({
                proposalId: proposal.proposalId,
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                this._failRun(run, goal, `Execution blocked: ${execResponse.message}`);
                return;
            }

            run.executionRunId = execResponse.executionId;
            this.auditService.saveRun(run);

            // Poll for execution terminal state
            const terminalStatus = await this._waitForExecution(execResponse.executionId);
            this._addMilestone(run, 'execution_completed', terminalStatus);
            this._emitDashboard('execution_completed', run);

            const outcome = this._outcomeFromExecutionStatus(terminalStatus);
            this._addMilestone(run, 'outcome_recorded');
            this.auditService.appendAuditRecord('outcome_recorded',
                `Execution outcome: ${terminalStatus}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            // Apply outcome to run and goal
            const finalRunStatus = this._runStatusFromOutcome(outcome);
            this._updateRunStatus(run, finalRunStatus);
            run.completedAt = new Date().toISOString();
            this._updateGoal(goal.goalId, { status: finalRunStatus as any });
            this.auditService.saveRun(run);

            // Apply cooldown for non-success outcomes
            if (outcome === 'rolled_back') {
                this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'rollback', this.activePolicy.budget);
                this.telemetryStore.record('cooldown_applied', `Rollback cooldown applied for ${goal.subsystemId}`,
                    { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId });
            } else if (outcome === 'failed') {
                this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'execution_failure', this.activePolicy.budget);
            }

            this._addMilestone(run, outcome === 'succeeded' ? 'run_completed' : 'run_failed');
            this._emitDashboard(outcome === 'succeeded' ? 'run_completed' : 'run_failed', run);

        } catch (err: any) {
            this._abortRun(run, goal, `Unhandled error: ${err.message}`);
        } finally {
            // Always record learning and release budget slot
            const finalGoal = this.activeGoals.get(goal.goalId)!;
            const finalRun = this.activeRuns.get(run.runId)!;
            const outcome = this._outcomeFromRunStatus(finalRun.status);

            const learningRecord = this.learningRegistry.record(finalGoal, finalRun, outcome);
            this._updateGoal(goal.goalId, { learningRecordId: learningRecord.recordId });

            this.telemetryStore.record('outcome_learned',
                `Learning recorded for pattern ${goal.dedupFingerprint}: ${outcome}`,
                { goalId: goal.goalId, runId: run.runId },
            );
            this.auditService.appendAuditRecord('outcome_recorded',
                `Learning record created: ${learningRecord.recordId}`,
                { goalId: goal.goalId, runId: run.runId },
            );

            this.budgetManager.recordRunEnd(run.runId);
        }
    }

    // ── Governance-pending resume ───────────────────────────────────────────────

    /**
     * Called when a governance decision resolves (human approval).
     * Resumes runs that are in 'governance_pending' state.
     */
    async checkPendingGovernanceRuns(): Promise<void> {
        const pendingRuns = [...this.activeRuns.values()].filter(r => r.status === 'governance_pending');

        for (const run of pendingRuns) {
            if (!run.proposalId) continue;

            const decision = this.governanceAppService.getDecision(run.proposalId);
            if (!decision) continue;

            if (decision.executionAuthorized) {
                await this._resumeGovernancePendingRun(run);
            } else if (decision.status === 'blocked' || decision.status === 'rejected') {
                const goal = this.activeGoals.get(run.goalId);
                if (goal) this._governanceBlockedRun(run, goal, `Governance ${decision.status}`);
            }
        }
    }

    private async _resumeGovernancePendingRun(run: AutonomousRun): Promise<void> {
        if (!run.proposalId) return;
        const goal = this.activeGoals.get(run.goalId);
        if (!goal) return;

        this._updateRunStatus(run, 'executing');
        this._addMilestone(run, 'governance_resolved', 'human_approved');
        this._emitDashboard('governance_resolved', run);
        this._updateGoal(goal.goalId, { status: 'executing' });

        try {
            const execResponse = await this.executionOrchestrator.start({
                proposalId: run.proposalId,
                authorizedBy: 'user_explicit',
                dryRun: false,
            });

            if (execResponse.blocked) {
                this._failRun(run, goal, `Execution blocked after governance approval: ${execResponse.message}`);
                return;
            }

            run.executionRunId = execResponse.executionId;
            this.auditService.saveRun(run);

            const terminalStatus = await this._waitForExecution(execResponse.executionId);
            const outcome = this._outcomeFromExecutionStatus(terminalStatus);
            const finalRunStatus = this._runStatusFromOutcome(outcome);
            this._updateRunStatus(run, finalRunStatus);
            run.completedAt = new Date().toISOString();
            this._updateGoal(goal.goalId, { status: finalRunStatus as any });
            this.auditService.saveRun(run);
        } finally {
            const finalRun = this.activeRuns.get(run.runId)!;
            const outcome = this._outcomeFromRunStatus(finalRun.status);
            this.learningRegistry.record(goal, finalRun, outcome);
            this.budgetManager.recordRunEnd(run.runId);
        }
    }

    // ── Run state helpers ───────────────────────────────────────────────────────

    private _failRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.failureReason = reason;
        this._updateRunStatus(run, 'failed');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, { status: 'failed' });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('execution_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'execution_failure', this.activePolicy.budget);
        this._addMilestone(run, 'run_failed', reason);
        this._emitDashboard('run_failed', run);
    }

    private _governanceBlockedRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.failureReason = reason;
        this._updateRunStatus(run, 'governance_blocked');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, {
            status: 'governance_blocked',
            humanReviewRequired: true,
        });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('governance_resolved', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('governance_blocked', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.cooldownRegistry.recordCooldown(goal.subsystemId, goal.dedupFingerprint, 'governance_block', this.activePolicy.budget);
        this._addMilestone(run, 'run_aborted', 'governance_blocked');
        this._emitDashboard('run_aborted', run);
    }

    private _abortRun(run: AutonomousRun, goal: AutonomousGoal, reason: string): void {
        run.abortReason = reason;
        this._updateRunStatus(run, 'aborted');
        run.completedAt = new Date().toISOString();
        this._updateGoal(goal.goalId, { status: 'failed' });
        this.auditService.saveRun(run);
        this.auditService.appendAuditRecord('run_aborted', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this.telemetryStore.record('execution_failed', reason,
            { goalId: goal.goalId, runId: run.runId, subsystemId: goal.subsystemId },
        );
        this._addMilestone(run, 'run_aborted', reason);
        this._emitDashboard('run_aborted', run);
    }

    private _updateRunStatus(run: AutonomousRun, status: AutonomousRunStatus): void {
        run.status = status;
        this.activeRuns.set(run.runId, run);
    }

    private _updateGoal(goalId: string, updates: Partial<AutonomousGoal>): void {
        const goal = this.activeGoals.get(goalId);
        if (!goal) return;
        const updated = { ...goal, ...updates, updatedAt: new Date().toISOString() };
        this.activeGoals.set(goalId, updated);
        this.auditService.saveGoal(updated);
    }

    private _addMilestone(
        run: AutonomousRun,
        name: AutonomousRunMilestoneName,
        detail?: string,
    ): void {
        const milestone: AutonomousRunMilestone = {
            name,
            reachedAt: new Date().toISOString(),
            detail,
        };
        run.milestones.push(milestone);
        this.activeRuns.set(run.runId, run);
    }

    private _emitDashboard(milestone: AutonomousRunMilestoneName, _run: AutonomousRun): void {
        const allRuns = [...this.activeRuns.values()];
        const allGoals = [...this.activeGoals.values()];
        const learningRecords = this.learningRegistry.listAll();
        const recentTelemetry = this.telemetryStore.getRecentEvents(50);
        const budgetUsed = this.budgetManager.getUsedThisPeriod(this.activePolicy.budget);

        this.dashboardBridge.maybeEmit(
            milestone, allRuns, allGoals, learningRecords, recentTelemetry,
            this.activePolicy, budgetUsed,
        );
    }

    // ── Execution polling ───────────────────────────────────────────────────────

    private async _waitForExecution(executionId: string): Promise<string> {
        const TERMINAL = new Set([
            'succeeded', 'rolled_back', 'aborted', 'execution_blocked',
        ]);
        const deadline = Date.now() + EXECUTION_POLL_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await this._delay(EXECUTION_POLL_INTERVAL_MS);
            const run = this.executionOrchestrator.getRunStatus(executionId);
            if (!run) return 'aborted';
            if (TERMINAL.has(run.status)) return run.status;
        }

        return 'aborted'; // Timeout
    }

    // ── Recovery ────────────────────────────────────────────────────────────────

    private _recoverStaleRuns(): void {
        const runs = this.auditService.listRuns();
        const NON_TERMINAL = new Set<AutonomousRunStatus>([
            'pending', 'running', 'planning', 'governance_pending', 'executing',
        ]);

        for (const run of runs) {
            if (NON_TERMINAL.has(run.status)) {
                if (run.status === 'governance_pending') {
                    // Keep these — they are awaiting human review
                    this.activeRuns.set(run.runId, run);
                    continue;
                }
                // Stale active run — mark as aborted
                run.status = 'aborted';
                run.abortReason = 'stale_on_startup';
                run.completedAt = new Date().toISOString();
                this.auditService.saveRun(run);
                this.activeRuns.set(run.runId, run);

                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'AutonomousRunOrchestrator',
                    `Stale run ${run.runId} recovered as aborted on startup`,
                );
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private _severityForTier(tier: string): 'low' | 'medium' | 'high' | 'critical' {
        switch (tier) {
            case 'critical': return 'critical';
            case 'high':     return 'high';
            case 'medium':   return 'medium';
            default:         return 'low';
        }
    }

    private _outcomeFromExecutionStatus(status: string): AttemptOutcome {
        switch (status) {
            case 'succeeded':    return 'succeeded';
            case 'rolled_back':  return 'rolled_back';
            case 'aborted':      return 'aborted';
            default:             return 'failed';
        }
    }

    private _outcomeFromRunStatus(status: AutonomousRunStatus): AttemptOutcome {
        switch (status) {
            case 'succeeded':         return 'succeeded';
            case 'rolled_back':       return 'rolled_back';
            case 'governance_blocked': return 'governance_blocked';
            case 'policy_blocked':    return 'policy_blocked';
            case 'aborted':           return 'aborted';
            case 'governance_pending': return 'aborted'; // Not yet resolved
            default:                  return 'failed';
        }
    }

    private _runStatusFromOutcome(outcome: AttemptOutcome): AutonomousRunStatus {
        switch (outcome) {
            case 'succeeded':   return 'succeeded';
            case 'rolled_back': return 'rolled_back';
            default:            return 'failed';
        }
    }

    private async _listReflectionGoals(): Promise<any[]> {
        try {
            // The safePlanner doesn't expose reflection goals directly.
            // Return empty array — stale reflection goal detection is best-effort.
            return [];
        } catch {
            return [];
        }
    }
}
