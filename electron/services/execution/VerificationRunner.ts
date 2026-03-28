/**
 * VerificationRunner.ts — Phase 3 P3F
 *
 * Executes the verification plan after a successful apply.
 *
 * Behavior:
 * - Runs commands through SafeCommandService (allowlist enforced).
 * - Records pass/fail/timeout per step.
 * - Stops early on critical step failure.
 * - Respects verification time and step budgets.
 * - Requires manual check recording when manualCheckRequired = true.
 *
 * Verification success (overallPassed) requires:
 *   - All critical steps passed.
 *   - No blockers.
 *   - Manual check recorded (if required).
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    VerificationExecutionPlan,
    VerificationExecutionResult,
    VerificationStepResult,
    ExecutionBudget,
} from '../../../shared/executionTypes';
import type { ExecutionBudgetManager } from './ExecutionBudgetManager';
import type { ExecutionAuditService } from './ExecutionAuditService';
import { SafeCommandService } from '../reflection/SafeCommandService';
import { telemetry } from '../TelemetryService';

// ─── VerificationRunner ───────────────────────────────────────────────────────

export class VerificationRunner {
    constructor(
        private readonly safeCommandService: SafeCommandService,
        private readonly budgetManager: ExecutionBudgetManager,
        private readonly auditService: ExecutionAuditService,
    ) {}

    /**
     * Executes all verification steps in the plan.
     *
     * @param executionId   Current execution run ID.
     * @param proposalId    Proposal being verified.
     * @param plan          Verification execution plan.
     * @param budget        Execution budget.
     */
    async run(
        executionId: string,
        proposalId: string,
        plan: VerificationExecutionPlan,
        budget: ExecutionBudget,
    ): Promise<VerificationExecutionResult> {
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        const stepResults: VerificationStepResult[] = [];
        const failedSteps: string[] = [];
        const blockers: string[] = [];
        let timeoutOccurred = false;

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'verification', 'verification_started',
            `Starting verification (${this._countCommands(plan)} command(s))`,
            'system', { planId: plan.planId },
        );

        const commands = this._buildCommandList(plan);

        for (const { command, isCritical } of commands) {
            // Time budget check
            const elapsed = Date.now() - startMs;
            if (elapsed >= plan.budgetMs) {
                timeoutOccurred = true;
                telemetry.operational(
                    'execution',
                    'execution.verification.timeout',
                    'warn',
                    'VerificationRunner',
                    `Verification timed out for ${executionId} after ${elapsed}ms`,
                );
                break;
            }

            // Step count budget
            const stepBudget = this.budgetManager.consume(
                executionId,
                'verificationStepsUsed',
                budget,
            );
            if (!stepBudget.allowed) {
                // Budget exhaustion is distinct from timeout — don't conflate them
                blockers.push(`Verification step budget exhausted`);
                break;
            }

            const stepId = uuidv4();
            const stepStart = Date.now();

            const result = await this.safeCommandService.runSafeCommand(
                command,
                Math.max(1000, plan.budgetMs - elapsed),
            );

            const durationMs = Date.now() - stepStart;
            const passed = result.exitCode === 0 && result.error !== 'BLOCKED';
            const blocked = result.error === 'BLOCKED';

            const stepResult: VerificationStepResult = {
                stepId,
                command,
                exitCode: result.exitCode,
                stdout: result.stdout.slice(0, 2048),  // cap to 2KB
                stderr: result.stderr.slice(0, 1024),  // cap to 1KB
                durationMs,
                passed,
                isCritical,
            };
            stepResults.push(stepResult);

            if (blocked) {
                blockers.push(`Command blocked by SafeCommandService: ${command}`);
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'verification', 'step_failed',
                    `Step BLOCKED: ${command}`,
                    'system', { stepId, command },
                );
                if (isCritical) break;
                continue;
            }

            if (!passed) {
                failedSteps.push(command);
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'verification', 'step_failed',
                    `Step failed (exit ${result.exitCode}): ${command}`,
                    'system', { stepId, exitCode: result.exitCode },
                );
                if (isCritical) {
                    blockers.push(`Critical step failed: ${command}`);
                    break;
                }
            } else {
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'verification', 'step_passed',
                    `Step passed: ${command}`,
                    'system', { stepId, durationMs },
                );
            }
        }

        const overallPassed =
            failedSteps.length === 0 &&
            blockers.length === 0 &&
            !timeoutOccurred &&
            (!plan.manualCheckRequired || false); // manual check starts as not recorded

        const completedAt = new Date().toISOString();

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'verification', 'verification_complete',
            `Verification complete: passed=${overallPassed}, steps=${stepResults.length}`,
            'system',
            { planId: plan.planId, overallPassed, failedSteps, blockers, timeoutOccurred },
        );

        telemetry.operational(
            'execution',
            overallPassed ? 'execution.verification.passed' : 'execution.verification.failed',
            overallPassed ? 'debug' : 'warn',
            'VerificationRunner',
            `Verification ${overallPassed ? 'passed' : 'failed'} for ${executionId}: ` +
            `${stepResults.length} step(s), ${failedSteps.length} failed`,
        );

        return {
            planId: plan.planId,
            executionId,
            startedAt,
            completedAt,
            stepResults,
            overallPassed,
            failedSteps,
            blockers,
            timeoutOccurred,
            manualCheckRequired: plan.manualCheckRequired,
            manualCheckRecorded: false,
        };
    }

    /**
     * Records a manual check result.
     * Called via IPC when the user confirms a manual check.
     */
    recordManualCheck(
        result: VerificationExecutionResult,
        passed: boolean,
    ): VerificationExecutionResult {
        return {
            ...result,
            manualCheckRecorded: true,
            overallPassed: passed && result.failedSteps.length === 0 && result.blockers.length === 0,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _buildCommandList(
        plan: VerificationExecutionPlan,
    ): Array<{ command: string; isCritical: boolean }> {
        const commands: Array<{ command: string; isCritical: boolean }> = [];

        if (plan.requiresLint) {
            commands.push({ command: 'npm run lint', isCritical: false });
        }
        if (plan.requiresTypecheck) {
            commands.push({ command: 'npm run typecheck', isCritical: true });
        }
        if (plan.requiresBuild) {
            commands.push({ command: 'npm run build', isCritical: true });
        }
        for (const pattern of plan.requiredTestPatterns) {
            commands.push({ command: `npm run test -- ${pattern}`, isCritical: false });
        }
        for (const smoke of plan.smokeChecks) {
            commands.push({ command: smoke, isCritical: false });
        }

        return commands;
    }

    private _countCommands(plan: VerificationExecutionPlan): number {
        return (
            (plan.requiresLint ? 1 : 0) +
            (plan.requiresTypecheck ? 1 : 0) +
            (plan.requiresBuild ? 1 : 0) +
            plan.requiredTestPatterns.length +
            plan.smokeChecks.length
        );
    }
}
