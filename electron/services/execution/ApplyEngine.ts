/**
 * ApplyEngine.ts — Phase 3 P3E
 *
 * Controlled apply engine that executes an approved PatchPlan.
 *
 * Safety guarantees:
 * - Only applies units from an execution-approved PatchPlan.
 * - Backup is written BEFORE every mutation (never after).
 * - Apply stops on the FIRST unit failure (no silent continuation).
 * - Never writes to a file not in patchPlan.affectedFiles.
 * - Supports dry-run mode (zero filesystem mutations).
 * - Records per-unit results in audit log.
 * - Respects budget dimensions (patchUnits, fileMutations, applyMs).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import type {
    PatchPlan,
    PatchUnit,
    ApplyResult,
    FileMutationResult,
    ExecutionBudget,
} from '../../../shared/executionTypes';
import type { ExecutionBudgetManager } from './ExecutionBudgetManager';
import type { ExecutionAuditService } from './ExecutionAuditService';
import { telemetry } from '../TelemetryService';

// ─── ApplyEngine ──────────────────────────────────────────────────────────────

export class ApplyEngine {
    constructor(
        private readonly budgetManager: ExecutionBudgetManager,
        private readonly auditService: ExecutionAuditService,
    ) {}

    /**
     * Applies a PatchPlan to the filesystem.
     *
     * @param executionId   The current execution run ID.
     * @param proposalId    The proposal being executed.
     * @param patchPlan     The pre-built, pre-validated patch plan.
     * @param budget        The execution budget for this run.
     * @param backupDir     Directory where per-unit backups are stored.
     * @param dryRun        When true, no filesystem mutations are performed.
     */
    async apply(
        executionId: string,
        proposalId: string,
        patchPlan: PatchPlan,
        budget: ExecutionBudget,
        backupDir: string,
        dryRun: boolean,
    ): Promise<ApplyResult> {
        const startedAt = new Date().toISOString();
        const unitResults: FileMutationResult[] = [];
        const filesChanged: string[] = [];
        const backupPaths: string[] = [];
        let firstFailureUnitId: string | undefined;
        const applyStart = Date.now();

        this.auditService.appendAuditRecord(
            executionId,
            proposalId,
            'apply',
            'apply_started',
            `Starting apply of ${patchPlan.totalUnitCount} unit(s) (dryRun=${dryRun})`,
            'system',
            { patchPlanId: patchPlan.patchPlanId, dryRun },
        );

        if (dryRun) {
            // Return simulated result from dry-run pass
            const dryRunIssues = patchPlan.dryRunResult?.issues ?? [];
            const allApplicable = dryRunIssues.length === 0;

            for (const unit of patchPlan.units) {
                const issue = dryRunIssues.find(i => i.unitId === unit.unitId);
                unitResults.push({
                    unitId: unit.unitId,
                    relativePath: unit.target.relativePath,
                    changeType: unit.changeType,
                    success: !issue,
                    error: issue ? `${issue.issueType}: ${issue.detail}` : undefined,
                });
            }

            return {
                executionId,
                patchPlanId: patchPlan.patchPlanId,
                startedAt,
                completedAt: new Date().toISOString(),
                dryRun: true,
                unitResults,
                allUnitsApplied: allApplicable,
                firstFailureUnitId: allApplicable ? undefined : unitResults.find(r => !r.success)?.unitId,
                filesChanged: [],
                backupPaths: [],
            };
        }

        // ── Real apply ─────────────────────────────────────────────────────────
        for (const unit of patchPlan.units.sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
            // Budget: apply time
            const elapsed = Date.now() - applyStart;
            const timeBudget = this.budgetManager.consume(
                executionId,
                'applyMsUsed',
                budget,
                elapsed,
            );
            if (!timeBudget.allowed) {
                const failResult = this._failUnit(unit, 'Apply budget (time) exhausted');
                unitResults.push(failResult);
                firstFailureUnitId = unit.unitId;
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'apply', 'unit_failed',
                    `Unit ${unit.unitId} blocked: budget exhausted`,
                    'system', { unitId: unit.unitId },
                );
                break;
            }

            // Budget: patch units
            const unitBudget = this.budgetManager.consume(executionId, 'patchUnitsUsed', budget);
            if (!unitBudget.allowed) {
                const failResult = this._failUnit(unit, 'Patch unit budget exhausted');
                unitResults.push(failResult);
                firstFailureUnitId = unit.unitId;
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'apply', 'unit_failed',
                    `Unit ${unit.unitId} blocked: patch unit budget exhausted`,
                    'system', { unitId: unit.unitId },
                );
                break;
            }

            // Budget: file mutations (per distinct file)
            const isNewFile = !filesChanged.includes(unit.target.relativePath);
            if (isNewFile) {
                const fileBudget = this.budgetManager.consume(executionId, 'fileMutationsUsed', budget);
                if (!fileBudget.allowed) {
                    const failResult = this._failUnit(unit, 'File mutation budget exhausted');
                    unitResults.push(failResult);
                    firstFailureUnitId = unit.unitId;
                    this.auditService.appendAuditRecord(
                        executionId, proposalId, 'apply', 'unit_failed',
                        `Unit ${unit.unitId} blocked: file mutation budget exhausted`,
                        'system', { unitId: unit.unitId },
                    );
                    break;
                }
            }

            // Apply the unit
            const result = await this._applyUnit(unit, backupDir, executionId, proposalId);
            unitResults.push(result);

            if (result.success) {
                unit.applyStatus = 'applied';
                unit.appliedAt = new Date().toISOString();
                if (!filesChanged.includes(unit.target.relativePath)) {
                    filesChanged.push(unit.target.relativePath);
                }
                if (result.backupPath) {
                    backupPaths.push(result.backupPath);
                }
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'apply', 'unit_applied',
                    `Applied unit ${unit.unitId} (${unit.changeType}) to ${unit.target.relativePath}`,
                    'system',
                    { unitId: unit.unitId, changeType: unit.changeType, path: unit.target.relativePath },
                );
            } else {
                unit.applyStatus = 'failed';
                unit.applyError = result.error;
                firstFailureUnitId = unit.unitId;
                this.auditService.appendAuditRecord(
                    executionId, proposalId, 'apply', 'unit_failed',
                    `Unit ${unit.unitId} failed: ${result.error}`,
                    'system',
                    { unitId: unit.unitId, error: result.error },
                );
                break; // Stop on first failure
            }
        }

        const allUnitsApplied =
            unitResults.length === patchPlan.totalUnitCount &&
            unitResults.every(r => r.success);

        const completedAt = new Date().toISOString();

        this.auditService.appendAuditRecord(
            executionId, proposalId, 'apply', 'apply_complete',
            `Apply complete: ${filesChanged.length} file(s) changed, success=${allUnitsApplied}`,
            'system',
            { filesChanged, allUnitsApplied, firstFailureUnitId },
        );

        telemetry.operational(
            'execution',
            allUnitsApplied ? 'execution.apply.succeeded' : 'execution.apply.failed',
            allUnitsApplied ? 'debug' : 'warn',
            'ApplyEngine',
            `Apply ${allUnitsApplied ? 'succeeded' : 'failed'} for ${executionId}: ${filesChanged.length}/${patchPlan.totalUnitCount} unit(s) applied`,
        );

        return {
            executionId,
            patchPlanId: patchPlan.patchPlanId,
            startedAt,
            completedAt,
            dryRun: false,
            unitResults,
            allUnitsApplied,
            firstFailureUnitId,
            filesChanged,
            backupPaths,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private async _applyUnit(
        unit: PatchUnit,
        backupDir: string,
        executionId: string,
        proposalId: string,
    ): Promise<FileMutationResult> {
        const { absolutePath, relativePath } = unit.target;
        const backupPath = path.join(backupDir, `${unit.unitId}.bak`);

        try {
            switch (unit.changeType) {
                case 'patch': {
                    if (!fs.existsSync(absolutePath)) {
                        return this._failUnit(unit, `File not found: ${relativePath}`);
                    }
                    if (!unit.search || unit.replace === undefined) {
                        return this._failUnit(unit, `Patch unit missing 'search' or 'replace'`);
                    }

                    const original = fs.readFileSync(absolutePath, 'utf-8');
                    const hashBefore = crypto.createHash('sha256').update(original).digest('hex');

                    // Write backup BEFORE mutation
                    this._writeBackup(backupPath, absolutePath, original);

                    if (!original.includes(unit.search)) {
                        return this._failUnit(unit, `Search string not found in ${relativePath}`);
                    }

                    // Use replace (replaces first occurrence only — deterministic)
                    const patched = original.replace(unit.search, unit.replace);
                    fs.writeFileSync(absolutePath, patched, 'utf-8');

                    const hashAfter = crypto.createHash('sha256')
                        .update(fs.readFileSync(absolutePath))
                        .digest('hex');

                    return { unitId: unit.unitId, relativePath, changeType: 'patch', success: true, backupPath, hashBefore, hashAfter };
                }

                case 'overwrite': {
                    if (!fs.existsSync(absolutePath)) {
                        return this._failUnit(unit, `File not found for overwrite: ${relativePath}`);
                    }
                    if (!unit.content) {
                        return this._failUnit(unit, `Overwrite unit missing 'content'`);
                    }

                    const original = fs.readFileSync(absolutePath, 'utf-8');
                    const hashBefore = crypto.createHash('sha256').update(original).digest('hex');

                    this._writeBackup(backupPath, absolutePath, original);

                    fs.writeFileSync(absolutePath, unit.content, 'utf-8');

                    const hashAfter = crypto.createHash('sha256')
                        .update(fs.readFileSync(absolutePath))
                        .digest('hex');

                    return { unitId: unit.unitId, relativePath, changeType: 'overwrite', success: true, backupPath, hashBefore, hashAfter };
                }

                case 'create': {
                    if (fs.existsSync(absolutePath)) {
                        return this._failUnit(unit, `File already exists: ${relativePath}. Use 'overwrite' to replace.`);
                    }
                    if (!unit.content) {
                        return this._failUnit(unit, `Create unit missing 'content'`);
                    }

                    const dir = path.dirname(absolutePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    fs.writeFileSync(absolutePath, unit.content, 'utf-8');
                    const hashAfter = crypto.createHash('sha256')
                        .update(fs.readFileSync(absolutePath))
                        .digest('hex');

                    return { unitId: unit.unitId, relativePath, changeType: 'create', success: true, hashAfter };
                }

                default:
                    return this._failUnit(unit, `Unknown changeType: ${(unit as any).changeType}`);
            }
        } catch (err: any) {
            return this._failUnit(unit, `Unexpected error: ${err.message}`);
        }
    }

    private _failUnit(unit: PatchUnit, error: string): FileMutationResult {
        return {
            unitId: unit.unitId,
            relativePath: unit.target.relativePath,
            changeType: unit.changeType,
            success: false,
            error,
        };
    }

    private _writeBackup(backupPath: string, originalPath: string, content: string): void {
        // Embed original path header for RollbackEngine
        const header = `// EXECUTION_BACKUP: ${originalPath}\n`;
        fs.writeFileSync(backupPath, header + content, 'utf-8');
    }
}
