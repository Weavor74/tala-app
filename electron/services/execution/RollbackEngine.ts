/**
 * RollbackEngine.ts — Phase 3 P3G
 *
 * Executes a rollback plan using checkpoints created during apply.
 *
 * Triggered by:
 *   - apply failure
 *   - verification failure
 *   - post-apply invariant failure
 *   - explicit user abort
 *   - timeout abort
 *
 * Behavior:
 *   - Restores files from backups written by ApplyEngine.
 *   - Deletes files that were created by apply.
 *   - One failed rollback step does NOT stop remaining steps.
 *   - All failures are audited.
 *   - rollback of rollback is NOT supported.
 */

import * as fs from 'fs';
import type {
    RollbackExecutionPlan,
    RollbackExecutionResult,
    RollbackStepResult,
    RollbackTrigger,
    ExecutionBudget,
} from '../../../shared/executionTypes';
import type { ExecutionBudgetManager } from './ExecutionBudgetManager';
import type { ExecutionAuditService } from './ExecutionAuditService';
import { telemetry } from '../TelemetryService';

// ─── Rollback header ──────────────────────────────────────────────────────────

const BACKUP_HEADER_PREFIX = '// EXECUTION_BACKUP: ';

// ─── RollbackEngine ───────────────────────────────────────────────────────────

export class RollbackEngine {
    constructor(
        private readonly budgetManager: ExecutionBudgetManager,
        private readonly auditService: ExecutionAuditService,
    ) {}

    /**
     * Executes all steps in the rollback plan.
     *
     * @param executionId   The current execution run ID.
     * @param proposalId    The proposal being rolled back.
     * @param plan          The pre-built rollback execution plan.
     * @param trigger       Why rollback was triggered.
     * @param budget        Execution budget.
     */
    async rollback(
        executionId: string,
        proposalId: string,
        plan: RollbackExecutionPlan,
        trigger: RollbackTrigger,
        budget: ExecutionBudget,
    ): Promise<RollbackExecutionResult> {
        const startedAt = new Date().toISOString();
        const stepResults: RollbackStepResult[] = [];
        const filesRestored: string[] = [];
        const filesNotRestored: string[] = [];

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'rollback', 'rollback_triggered',
            `Rollback triggered (reason: ${trigger})`,
            'system', { trigger, planId: plan.planId, stepCount: plan.steps.length },
        );

        telemetry.operational(
            'execution',
            'execution.rollback.started',
            'warn',
            'RollbackEngine',
            `Rollback started for ${executionId} (trigger: ${trigger}, ${plan.steps.length} step(s))`,
        );

        const sortedSteps = [...plan.steps].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

        for (const step of sortedSteps) {
            // Budget check — non-fatal: we continue rollback even if budget dimension exhausted
            const stepBudget = this.budgetManager.consume(
                executionId,
                'rollbackStepsUsed',
                budget,
            );
            if (!stepBudget.allowed) {
                stepResults.push({
                    stepId: step.stepId,
                    success: false,
                    detail: 'Rollback step budget exhausted — step skipped',
                });
                if (step.targetPath) {
                    filesNotRestored.push(step.targetPath);
                }
                continue;
            }

            let stepSuccess = false;
            let stepDetail = '';

            try {
                switch (step.type) {
                    case 'restore_file': {
                        if (!step.backupPath || !step.targetPath) {
                            stepDetail = 'Missing backupPath or targetPath';
                            break;
                        }
                        if (!fs.existsSync(step.backupPath)) {
                            stepDetail = `Backup not found: ${step.backupPath}`;
                            filesNotRestored.push(step.targetPath);
                            break;
                        }

                        const backupContent = fs.readFileSync(step.backupPath, 'utf-8');
                        // Strip the EXECUTION_BACKUP header
                        const headerEnd = backupContent.indexOf('\n');
                        const firstLine = backupContent.substring(0, headerEnd);
                        const originalContent = firstLine.startsWith(BACKUP_HEADER_PREFIX)
                            ? backupContent.substring(headerEnd + 1)
                            : backupContent; // No header — write as-is

                        fs.writeFileSync(step.targetPath, originalContent, 'utf-8');
                        filesRestored.push(step.targetPath);
                        stepSuccess = true;
                        stepDetail = `Restored ${step.targetPath}`;
                        break;
                    }

                    case 'delete_created_file': {
                        if (!step.targetPath) {
                            stepDetail = 'Missing targetPath';
                            break;
                        }
                        if (!fs.existsSync(step.targetPath)) {
                            // File doesn't exist — already clean
                            stepSuccess = true;
                            stepDetail = `File already absent: ${step.targetPath}`;
                            break;
                        }

                        fs.unlinkSync(step.targetPath);
                        stepSuccess = true;
                        stepDetail = `Deleted created file: ${step.targetPath}`;
                        filesRestored.push(step.targetPath);
                        break;
                    }

                    case 'manual_instruction': {
                        // Log instruction to audit; mark as needing human action
                        stepDetail = `Manual action required: ${step.instruction ?? '(no instruction provided)'}`;
                        stepSuccess = false; // Cannot auto-complete
                        break;
                    }

                    default:
                        stepDetail = `Unknown step type: ${(step as any).type}`;
                }
            } catch (err: any) {
                stepDetail = `Exception during rollback step: ${err.message}`;
                if (step.targetPath) {
                    filesNotRestored.push(step.targetPath);
                }
            }

            stepResults.push({ stepId: step.stepId, success: stepSuccess, detail: stepDetail });

            this.auditService.appendAuditRecord(
                executionId, proposalId, 'rollback', 'rollback_step_done',
                `Rollback step ${step.stepId} (${step.type}): ${stepDetail}`,
                'system',
                { stepId: step.stepId, type: step.type, success: stepSuccess },
            );
        }

        // Success = no files failed to restore (empty plan is trivially successful)
        const overallSuccess = filesNotRestored.length === 0;
        const completedAt = new Date().toISOString();

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'rollback', 'rollback_complete',
            `Rollback complete: restored=${filesRestored.length}, failed=${filesNotRestored.length}`,
            'system',
            { filesRestored, filesNotRestored, overallSuccess },
        );

        telemetry.operational(
            'execution',
            overallSuccess ? 'execution.rollback.succeeded' : 'execution.rollback.partial',
            overallSuccess ? 'debug' : 'warn',
            'RollbackEngine',
            `Rollback ${overallSuccess ? 'succeeded' : 'partially failed'} for ${executionId}: ` +
            `${filesRestored.length} restored, ${filesNotRestored.length} not restored`,
        );

        return {
            planId: plan.planId,
            executionId,
            startedAt,
            completedAt,
            trigger,
            stepResults,
            overallSuccess,
            filesRestored,
            filesNotRestored,
        };
    }
}
