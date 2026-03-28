/**
 * ExecutionOrchestrator.ts — Phase 3 Main Orchestrator
 *
 * Sequences the controlled execution pipeline:
 *
 *   eligibility gate → execution snapshot → patch plan build →
 *   dry-run pass → apply → verification → (success | rollback) → outcome
 *
 * Enforces:
 * - Only promoted proposals execute
 * - File-bounded, proposal-bounded mutations
 * - Verification required for success
 * - Rollback path exists before apply
 * - Full audit trail
 * - One active execution per subsystem
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    ExecutionRun,
    ExecutionStatus,
    ExecutionAuthorization,
    ExecutionStartRequest,
    ExecutionStartResponse,
    ExecutionMilestone,
    ExecutionMilestoneName,
    ExecutionOutcome,
    VerificationExecutionPlan,
    RollbackTrigger,
} from '../../../shared/executionTypes';
import type { SafeChangeProposal } from '../../../shared/reflectionPlanTypes';
import { ExecutionRunRegistry } from './ExecutionRunRegistry';
import { ExecutionBudgetManager } from './ExecutionBudgetManager';
import { ExecutionEligibilityGate } from './ExecutionEligibilityGate';
import { ExecutionSnapshotService } from './ExecutionSnapshotService';
import { PatchPlanBuilder } from './PatchPlanBuilder';
import { ApplyEngine } from './ApplyEngine';
import { VerificationRunner } from './VerificationRunner';
import { RollbackEngine } from './RollbackEngine';
import { ExecutionAuditService } from './ExecutionAuditService';
import { ExecutionTelemetryStore } from './ExecutionTelemetryStore';
import { ExecutionDashboardBridge } from './ExecutionDashboardBridge';
import { ProtectedFileRegistry } from '../reflection/ProtectedFileRegistry';
import { SafeCommandService } from '../reflection/SafeCommandService';
import { telemetry } from '../TelemetryService';

// ─── ExecutionOrchestrator ────────────────────────────────────────────────────

export class ExecutionOrchestrator {
    private readonly registry: ExecutionRunRegistry;
    private readonly budgetManager: ExecutionBudgetManager;
    private readonly eligibilityGate: ExecutionEligibilityGate;
    private readonly snapshotService: ExecutionSnapshotService;
    private readonly patchPlanBuilder: PatchPlanBuilder;
    private readonly applyEngine: ApplyEngine;
    private readonly verificationRunner: VerificationRunner;
    private readonly rollbackEngine: RollbackEngine;
    private readonly auditService: ExecutionAuditService;
    private readonly telemetryStore: ExecutionTelemetryStore;
    private readonly dashboardBridge: ExecutionDashboardBridge;

    constructor(
        private readonly dataDir: string,
        private readonly workspaceRoot: string,
        private readonly knownInvariantIds: () => string[],
        private readonly getProposal: (proposalId: string) => SafeChangeProposal | null,
    ) {
        this.registry = new ExecutionRunRegistry();
        this.budgetManager = new ExecutionBudgetManager();
        this.eligibilityGate = new ExecutionEligibilityGate(this.registry);
        this.snapshotService = new ExecutionSnapshotService();
        const protectedRegistry = new ProtectedFileRegistry();
        this.patchPlanBuilder = new PatchPlanBuilder(protectedRegistry, workspaceRoot);
        this.auditService = new ExecutionAuditService(dataDir);
        this.applyEngine = new ApplyEngine(this.budgetManager, this.auditService);
        const safeCmd = new SafeCommandService(workspaceRoot);
        this.verificationRunner = new VerificationRunner(safeCmd, this.budgetManager, this.auditService);
        this.rollbackEngine = new RollbackEngine(this.budgetManager, this.auditService);
        this.telemetryStore = new ExecutionTelemetryStore(dataDir);
        this.dashboardBridge = new ExecutionDashboardBridge();

        this.telemetryStore.startAutoFlush();
        this._recoverStaleRuns();
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Starts a controlled execution run for the given request.
     *
     * Returns immediately with status and eligibility result.
     * The actual pipeline runs asynchronously.
     */
    async start(request: ExecutionStartRequest): Promise<ExecutionStartResponse> {
        const { proposalId, dryRun = false } = request;

        const proposal = this.getProposal(proposalId);
        if (!proposal) {
            return {
                executionId: '',
                status: 'execution_blocked',
                message: `Proposal '${proposalId}' not found`,
                blocked: true,
            };
        }

        const authorization: ExecutionAuthorization = {
            authorizedAt: new Date().toISOString(),
            authorizedBy: request.authorizedBy,
            proposalStatus: proposal.status,
            authorizationToken: uuidv4(),
        };

        // Eligibility gate (synchronous, deterministic)
        const eligibilityResult = this.eligibilityGate.evaluate(
            proposal,
            authorization,
            this.knownInvariantIds(),
        );

        if (!eligibilityResult.eligible) {
            this.telemetryStore.record(
                'no_run',
                'eligibility',
                'gate',
                `Eligibility blocked: ${eligibilityResult.message}`,
                { proposalId },
            );
            return {
                executionId: '',
                status: 'execution_blocked',
                message: eligibilityResult.message,
                eligibilityResult,
                blocked: true,
            };
        }

        // Create execution run
        const executionId = uuidv4();
        const budget = this.budgetManager.createBudget();
        this.budgetManager.initRun(executionId);

        const backupDir = this.auditService.ensureBackupDir(executionId);
        const auditPointer = `execution/audit/${executionId}.jsonl`;

        const run: ExecutionRun = {
            executionId,
            proposalId,
            planRunId: proposal.runId,
            subsystemId: proposal.targetSubsystem,
            targetFiles: proposal.targetFiles,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'pending_execution',
            authorization,
            eligibilityResult,
            auditPointer,
            budget,
            usage: this.budgetManager.getUsage(executionId),
            milestones: [],
            dryRun,
        };

        this.registry.registerRun(run);
        this.registry.lockSubsystem(proposal.targetSubsystem, executionId);
        this.auditService.saveRun(run);

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'authorization', 'run_created',
            `Execution run created (dryRun=${dryRun})`,
            'user',
            { proposalId, subsystemId: proposal.targetSubsystem, dryRun },
        );
        this.auditService.appendAuditRecord(
            executionId, proposalId, 'eligibility', 'gate_passed',
            'Eligibility gate passed',
            'system',
        );

        this._addMilestone(executionId, 'execution_created');
        this._addMilestone(executionId, 'eligibility_passed');
        this._maybeEmitDashboard('eligibility_passed', executionId);

        // Run pipeline asynchronously (fire-and-forget with error capture)
        this._runPipeline(executionId, proposal, backupDir, dryRun).catch(err => {
            telemetry.operational(
                'execution',
                'execution.pipeline.unhandled_error',
                'error',
                'ExecutionOrchestrator',
                `Unhandled error in pipeline for ${executionId}: ${err.message}`,
            );
            this._abort(executionId, proposalId, `Unhandled pipeline error: ${err.message}`);
        });

        return {
            executionId,
            status: 'validating',
            message: `Execution run created — pipeline started`,
            eligibilityResult,
            blocked: false,
        };
    }

    abortRun(executionId: string, reason: string): boolean {
        const run = this.registry.getRun(executionId);
        if (!run) return false;
        this._abort(executionId, run.proposalId, reason);
        return true;
    }

    getRunStatus(executionId: string): ExecutionRun | null {
        return this.registry.getRun(executionId);
    }

    listRecentRuns(windowMs?: number): ExecutionRun[] {
        return this.registry.listRecent(windowMs);
    }

    getAuditLog(executionId: string) {
        return this.auditService.readAuditLog(executionId);
    }

    getDashboardState(promotedProposalsReady: number): import('../../../shared/executionTypes').ExecutionDashboardState {
        const allRuns = this.registry.listRecent();
        const activeRun = allRuns.find(r =>
            r.status !== 'succeeded' &&
            r.status !== 'rolled_back' &&
            r.status !== 'aborted' &&
            r.status !== 'execution_blocked',
        );

        const total = allRuns.length;
        const succeeded = allRuns.filter(r => r.status === 'succeeded').length;
        const failedVerification = allRuns.filter(r => r.status === 'failed_verification').length;
        const rolledBack = allRuns.filter(r => r.status === 'rolled_back').length;
        const aborted = allRuns.filter(r => r.status === 'aborted').length;
        const active = allRuns.filter(r => r.status !== 'succeeded' && r.status !== 'rolled_back' && r.status !== 'aborted' && r.status !== 'execution_blocked').length;

        return {
            kpis: {
                totalExecutions: total,
                succeeded,
                failedVerification,
                rolledBack,
                aborted,
                activeExecutions: active,
                successRate: total > 0 ? Math.round((succeeded / total) * 100) / 100 : 0,
            },
            activeRun,
            recentRuns: allRuns.slice(0, 10),
            promotedProposalsReady,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    recordManualCheck(executionId: string, passed: boolean, notes?: string): boolean {
        const run = this.registry.getRun(executionId);
        if (!run?.verificationResult) return false;

        const updated = this.verificationRunner.recordManualCheck(run.verificationResult, passed);
        this.registry.updateRun(executionId, { verificationResult: updated });
        this.auditService.saveRun(this.registry.getRun(executionId)!);

        this.auditService.appendAuditRecord(
            executionId, run.proposalId, 'verification', passed ? 'step_passed' : 'step_failed',
            `Manual check recorded: passed=${passed}` + (notes ? ` — ${notes}` : ''),
            'user',
        );

        // If manual check completes verification, continue pipeline
        if (updated.overallPassed && run.status === 'verifying') {
            this._transitionStatus(executionId, 'succeeded');
            this._recordOutcome(executionId, run.proposalId, 'succeeded');
        } else if (!passed && run.status === 'verifying') {
            this._transitionStatus(executionId, 'failed_verification');
            // Trigger rollback
            if (run.rollbackPlan) {
                this._executeRollback(executionId, run.proposalId, run.rollbackPlan, 'verification_failure', run.budget);
            }
        }

        return true;
    }

    pruneOldRuns(retentionMs?: number): number {
        return this.registry.pruneOldRuns(retentionMs);
    }

    // ── Pipeline ────────────────────────────────────────────────────────────────

    private async _runPipeline(
        executionId: string,
        proposal: SafeChangeProposal,
        backupDir: string,
        dryRun: boolean,
    ): Promise<void> {
        const run = this.registry.getRun(executionId)!;
        const { budget, proposalId } = run;

        // ── P3C: Execution Snapshot ──────────────────────────────────────────
        this._transitionStatus(executionId, 'validating');

        const snapshot = this.snapshotService.capture(
            executionId,
            proposal,
            this.workspaceRoot,
            this.knownInvariantIds(),
        );

        this.registry.updateRun(executionId, { snapshot });

        if (!snapshot.compatible) {
            this.auditService.appendAuditRecord(
                executionId, proposalId, 'snapshot', 'snapshot_stale',
                `Snapshot incompatible: ${snapshot.incompatibilityReasons.join('; ')}`,
                'system',
            );
            this._abort(executionId, proposalId, `Snapshot incompatible — replan required: ${snapshot.incompatibilityReasons.join('; ')}`);
            return;
        }

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'snapshot', 'snapshot_captured',
            'Execution-time snapshot captured and compatible',
            'system',
        );
        this._addMilestone(executionId, 'snapshot_ready');
        this._maybeEmitDashboard('snapshot_ready', executionId);

        // ── P3D: Patch Plan Build ────────────────────────────────────────────
        let patchPlan: import('../../../shared/executionTypes').PatchPlan;
        let rollbackPlan: import('../../../shared/executionTypes').RollbackExecutionPlan;

        try {
            const built = this.patchPlanBuilder.build(executionId, proposal, backupDir);
            patchPlan = built.patchPlan;
            rollbackPlan = built.rollbackPlan;
        } catch (err: any) {
            this.auditService.appendAuditRecord(
                executionId, proposalId, 'patch_plan', 'aborted',
                `Patch plan build failed: ${err.message}`,
                'system',
            );
            this._abort(executionId, proposalId, `Patch plan build failed: ${err.message}`);
            return;
        }

        this.registry.updateRun(executionId, { patchPlan, rollbackPlan });
        this.auditService.appendAuditRecord(
            executionId, proposalId, 'patch_plan', 'patch_plan_built',
            `Patch plan built: ${patchPlan.totalUnitCount} unit(s)`,
            'system', { patchPlanId: patchPlan.patchPlanId },
        );
        this._addMilestone(executionId, 'patch_plan_ready');

        // ── Dry-run validation ───────────────────────────────────────────────
        if (!patchPlan.dryRunResult!.allUnitsApplicable) {
            const issues = patchPlan.dryRunResult!.issues;
            this.auditService.appendAuditRecord(
                executionId, proposalId, 'dry_run', 'dry_run_failed',
                `Dry-run failed: ${issues.length} issue(s)`,
                'system', { issues },
            );
            this._addMilestone(executionId, 'dry_run_complete', 'dry_run_failed');
            this._abort(executionId, proposalId, `Dry-run failed: ${issues.map(i => i.detail).join('; ')}`);
            return;
        }

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'dry_run', 'dry_run_passed',
            'Dry-run passed — all units applicable',
            'system',
        );
        this._addMilestone(executionId, 'dry_run_complete');
        this._maybeEmitDashboard('dry_run_complete', executionId);

        this._transitionStatus(executionId, 'ready_to_apply');

        // ── P3E: Apply ───────────────────────────────────────────────────────
        this._transitionStatus(executionId, 'applying');
        this.auditService.saveRun(this.registry.getRun(executionId)!);

        const applyResult = await this.applyEngine.apply(
            executionId,
            proposalId,
            patchPlan,
            budget,
            backupDir,
            dryRun,
        );

        this.registry.updateRun(executionId, { applyResult });
        this._addMilestone(executionId, 'apply_complete');
        this._maybeEmitDashboard('apply_complete', executionId);

        if (!applyResult.allUnitsApplied) {
            this._transitionStatus(executionId, 'rollback_pending');
            await this._executeRollback(executionId, proposalId, rollbackPlan, 'apply_failure', budget);
            return;
        }

        if (dryRun) {
            // Dry-run complete — no filesystem changes
            this._transitionStatus(executionId, 'succeeded');
            this._recordOutcome(executionId, proposalId, 'succeeded');
            return;
        }

        // ── P3F: Verification ────────────────────────────────────────────────
        this._transitionStatus(executionId, 'verifying');

        const verificationPlan = this._buildVerificationPlan(executionId, proposal);
        const verificationResult = await this.verificationRunner.run(
            executionId,
            proposalId,
            verificationPlan,
            budget,
        );

        this.registry.updateRun(executionId, { verificationResult });
        this._addMilestone(executionId, 'verification_complete');
        this._maybeEmitDashboard('verification_complete', executionId);

        if (verificationResult.manualCheckRequired && !verificationResult.manualCheckRecorded) {
            // Stay in 'verifying' — waiting for manual check via recordManualCheck()
            this.auditService.saveRun(this.registry.getRun(executionId)!);
            return;
        }

        if (!verificationResult.overallPassed) {
            this._transitionStatus(executionId, 'failed_verification');
            await this._executeRollback(executionId, proposalId, rollbackPlan, 'verification_failure', budget);
            return;
        }

        // ── Success ──────────────────────────────────────────────────────────
        this._transitionStatus(executionId, 'succeeded');
        this._recordOutcome(executionId, proposalId, 'succeeded');
    }

    // ── Rollback helper ─────────────────────────────────────────────────────────

    private async _executeRollback(
        executionId: string,
        proposalId: string,
        rollbackPlan: import('../../../shared/executionTypes').RollbackExecutionPlan,
        trigger: RollbackTrigger,
        budget: import('../../../shared/executionTypes').ExecutionBudget,
    ): Promise<void> {
        this._transitionStatus(executionId, 'rolling_back');

        const rollbackResult = await this.rollbackEngine.rollback(
            executionId,
            proposalId,
            rollbackPlan,
            trigger,
            budget,
        );

        this.registry.updateRun(executionId, { rollbackResult });
        this._addMilestone(executionId, 'rollback_complete');
        this._maybeEmitDashboard('rollback_complete', executionId);

        const finalStatus = rollbackResult.overallSuccess ? 'rolled_back' : 'aborted';
        this._transitionStatus(executionId, finalStatus);
        this._recordOutcome(executionId, proposalId, rollbackResult.overallSuccess ? 'rolled_back' : 'aborted');
    }

    // ── Outcome & status helpers ────────────────────────────────────────────────

    private _transitionStatus(executionId: string, status: ExecutionStatus): void {
        this.registry.updateRun(executionId, { status });

        const run = this.registry.getRun(executionId);
        if (run) {
            this.auditService.saveRun(run);
        }

        const TERMINAL: ExecutionStatus[] = ['succeeded', 'rolled_back', 'aborted', 'execution_blocked'];
        if (TERMINAL.includes(status)) {
            const run2 = this.registry.getRun(executionId);
            if (run2) {
                this.registry.unlockSubsystem(run2.subsystemId);
                this.registry.setCooldown(
                    run2.subsystemId,
                    status === 'succeeded' ? 'success' : 'failure',
                    `After execution ${executionId}`,
                );
                this.budgetManager.clearRun(executionId);
            }
        }
    }

    private _recordOutcome(
        executionId: string,
        proposalId: string,
        outcomeType: import('../../../shared/executionTypes').ExecutionOutcomeType,
    ): void {
        const run = this.registry.getRun(executionId);
        if (!run) return;

        const filesChanged = run.applyResult?.filesChanged ?? [];
        const filesRestored = run.rollbackResult?.filesRestored ?? [];

        const outcome: ExecutionOutcome = {
            executionId,
            proposalId,
            outcomeType,
            recordedAt: new Date().toISOString(),
            filesChanged,
            filesRestored,
            verificationPassed: run.verificationResult?.overallPassed ?? false,
            rollbackPerformed: !!run.rollbackResult,
            summary: `Execution ${outcomeType}: ${filesChanged.length} file(s) changed, verification=${run.verificationResult?.overallPassed ?? 'n/a'}`,
        };

        this.registry.updateRun(executionId, { outcome });
        this.auditService.appendAuditRecord(
            executionId, proposalId, 'outcome', 'outcome_recorded',
            outcome.summary,
            'system', { outcomeType, filesChanged, filesRestored },
        );
        this._addMilestone(executionId, 'outcome_recorded');
        this._maybeEmitDashboard('outcome_recorded', executionId);

        const finalRun = this.registry.getRun(executionId);
        if (finalRun) this.auditService.saveRun(finalRun);

        telemetry.operational(
            'execution',
            `execution.outcome.${outcomeType}`,
            outcomeType === 'succeeded' ? 'debug' : 'warn',
            'ExecutionOrchestrator',
            `Execution ${executionId} outcome: ${outcomeType}`,
        );
    }

    private _abort(executionId: string, proposalId: string, reason: string): void {
        this.auditService.appendAuditRecord(
            executionId, proposalId, 'system', 'aborted',
            `Execution aborted: ${reason}`,
            'system',
        );
        this.registry.updateRun(executionId, { abortReason: reason });
        this._transitionStatus(executionId, 'aborted');
        this._recordOutcome(executionId, proposalId, 'aborted');
    }

    private _addMilestone(executionId: string, name: ExecutionMilestoneName, notes?: string): void {
        const run = this.registry.getRun(executionId);
        if (!run) return;
        const milestone: ExecutionMilestone = { name, timestamp: new Date().toISOString(), notes };
        this.registry.updateRun(executionId, { milestones: [...run.milestones, milestone] });
    }

    private _maybeEmitDashboard(milestone: ExecutionMilestoneName, executionId: string): void {
        const run = this.registry.getRun(executionId);
        if (!run) return;

        const allRuns = this.registry.listRecent();
        const budgetResult = this.budgetManager.consume(executionId, 'dashboardUpdatesUsed', run.budget);

        if (!budgetResult.allowed) return;

        // Revert the consume — maybeEmit will track internally
        // (We consume optimistically here as a guard)
        this.dashboardBridge.maybeEmit(
            milestone,
            run,
            allRuns,
            0, // promotedProposalsReady — caller knows; 0 is safe default here
            run.usage.dashboardUpdatesUsed,
            run.budget.maxDashboardUpdates,
        );

        const updated = this.registry.getRun(executionId);
        if (updated) {
            updated.usage = this.budgetManager.getUsage(executionId);
        }
    }

    // ── Verification plan helper ────────────────────────────────────────────────

    private _buildVerificationPlan(
        executionId: string,
        proposal: SafeChangeProposal,
    ): VerificationExecutionPlan {
        const vr = proposal.verificationRequirements;
        return {
            planId: uuidv4(),
            executionId,
            requiresBuild: vr.requiresBuild,
            requiresTypecheck: vr.requiresTypecheck,
            requiresLint: vr.requiresLint,
            requiredTestPatterns: vr.requiredTests,
            smokeChecks: vr.smokeChecks,
            manualCheckRequired: vr.manualReviewRequired,
            budgetMs: vr.estimatedDurationMs > 0 ? vr.estimatedDurationMs : 120_000,
        };
    }

    // ── Crash recovery ──────────────────────────────────────────────────────────

    /**
     * On startup, scan for execution runs left in 'applying' state by a crash.
     * Auto-abort them with crash_recovery reason.
     */
    private _recoverStaleRuns(): void {
        try {
            const persisted = this.auditService.listPersistedRuns();
            const staleStatuses = new Set<ExecutionStatus>([
                'pending_execution', 'validating', 'ready_to_apply', 'applying',
            ]);

            for (const run of persisted) {
                if (staleStatuses.has(run.status)) {
                    // Re-register in memory so abort can find it
                    this.registry.registerRun(run);
                    this.registry.lockSubsystem(run.subsystemId, run.executionId);
                    this.budgetManager.initRun(run.executionId);

                    this._abort(
                        run.executionId,
                        run.proposalId,
                        `crash_recovery: run was in '${run.status}' state at startup`,
                    );

                    telemetry.operational(
                        'execution',
                        'execution.crash_recovery.aborted',
                        'warn',
                        'ExecutionOrchestrator',
                        `Crash-recovered stale run ${run.executionId} (was: ${run.status})`,
                    );
                }
            }
        } catch {
            // Non-fatal
        }
    }
}
