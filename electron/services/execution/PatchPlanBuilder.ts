/**
 * PatchPlanBuilder.ts — Phase 3 P3D
 *
 * Transforms an approved SafeChangeProposal into an executable PatchPlan.
 *
 * Each PatchUnit targets exactly one file and is fully explicit:
 *   - target file (relative + absolute path)
 *   - mutation type (patch | overwrite | create)
 *   - expected precondition (search string for patch; file existence for overwrite)
 *   - intended postcondition (replace string or content)
 *
 * Scope enforcement:
 *   - Only files listed in proposal.targetFiles may have units.
 *   - Protected files with !allowStagedEdit are blocked at build time.
 *   - Dry-run pass validates preconditions before any write.
 *
 * Rollback plan is generated simultaneously so it is available before apply.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    PatchPlan,
    PatchUnit,
    FileMutationTarget,
    DryRunResult,
    DryRunIssue,
    RollbackExecutionPlan,
    RollbackStep,
} from '../../../shared/executionTypes';
import type { SafeChangeProposal, ProposalChange } from '../../../shared/reflectionPlanTypes';
import type { ProtectedFileRegistry } from '../reflection/ProtectedFileRegistry';
import { telemetry } from '../TelemetryService';

// ─── PatchPlanBuilder ─────────────────────────────────────────────────────────

export class PatchPlanBuilder {
    constructor(
        private readonly protectedRegistry: ProtectedFileRegistry,
        private readonly workspaceRoot: string,
    ) {}

    /**
     * Builds a PatchPlan and RollbackExecutionPlan from an approved proposal.
     *
     * @throws Error when scope enforcement or protection checks fail.
     */
    build(
        executionId: string,
        proposal: SafeChangeProposal,
        backupDir: string,
    ): { patchPlan: PatchPlan; rollbackPlan: RollbackExecutionPlan } {
        const patchPlanId = uuidv4();
        const targetFileSet = new Set(proposal.targetFiles);
        const units: PatchUnit[] = [];
        const rollbackSteps: RollbackStep[] = [];
        let seqNum = 1;

        for (const change of proposal.changes) {
            // ── Scope enforcement ────────────────────────────────────────────────
            if (!targetFileSet.has(change.path)) {
                throw new Error(
                    `Scope violation: change targets '${change.path}' which is not in proposal.targetFiles`,
                );
            }

            const relativePath = change.path.replace(/\\/g, '/');
            const absolutePath = path.resolve(this.workspaceRoot, relativePath);

            // ── Protection check ─────────────────────────────────────────────────
            const protection = this.protectedRegistry.getFileProtection(relativePath);
            if (protection && !protection.allowStagedEdit) {
                throw new Error(
                    `Protected file blocked: '${relativePath}' (rule: ${protection.ruleId}) — immutable files cannot be patched`,
                );
            }

            const target: FileMutationTarget = {
                relativePath,
                absolutePath,
                isProtected: protection !== null,
            };

            const changeType = change.type === 'modify' ? 'overwrite' :
                               change.type === 'create' ? 'create' :
                               change.type === 'patch'  ? 'patch' : 'patch';

            const unitId = uuidv4();
            const backupPath = path.join(backupDir, `${unitId}.bak`);

            const unit: PatchUnit = {
                unitId,
                patchPlanId,
                sequenceNumber: seqNum++,
                target,
                changeType,
                search: change.search,
                replace: change.replace,
                content: change.content,
                reasoning: change.reasoning,
                applyStatus: 'pending',
            };
            units.push(unit);

            // ── Build corresponding rollback step ────────────────────────────────
            if (changeType === 'create') {
                rollbackSteps.push({
                    stepId: uuidv4(),
                    sequenceNumber: seqNum - 1,
                    type: 'delete_created_file',
                    targetPath: absolutePath,
                });
            } else {
                // patch / overwrite — restore from backup
                rollbackSteps.push({
                    stepId: uuidv4(),
                    sequenceNumber: seqNum - 1,
                    type: 'restore_file',
                    targetPath: absolutePath,
                    backupPath,
                });
            }
        }

        // ── Dry-run pass ──────────────────────────────────────────────────────
        const dryRunResult = this._dryRun(units);

        const affectedFiles = [...new Set(units.map(u => u.target.relativePath))].sort();

        const patchPlan: PatchPlan = {
            patchPlanId,
            executionId,
            proposalId: proposal.proposalId,
            createdAt: new Date().toISOString(),
            units,
            totalUnitCount: units.length,
            affectedFiles,
            dryRunResult,
        };

        const rollbackPlan: RollbackExecutionPlan = {
            planId: uuidv4(),
            executionId,
            strategy: proposal.rollbackClassification.strategy,
            steps: rollbackSteps,
            estimatedMs: proposal.rollbackClassification.estimatedRollbackMs ?? 0,
            createdAt: new Date().toISOString(),
        };

        telemetry.operational(
            'execution',
            'execution.patch_plan.built',
            'debug',
            'PatchPlanBuilder',
            `Built patch plan ${patchPlanId} with ${units.length} unit(s) for execution ${executionId}`,
        );

        return { patchPlan, rollbackPlan };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _dryRun(units: PatchUnit[]): DryRunResult {
        const issues: DryRunIssue[] = [];

        for (const unit of units) {
            const { absolutePath } = unit.target;
            const exists = fs.existsSync(absolutePath);

            if (unit.changeType === 'create') {
                if (exists) {
                    issues.push({
                        unitId: unit.unitId,
                        issueType: 'file_already_exists',
                        detail: `File already exists: ${unit.target.relativePath}`,
                    });
                }
            } else if (unit.changeType === 'patch') {
                if (!exists) {
                    issues.push({
                        unitId: unit.unitId,
                        issueType: 'file_missing',
                        detail: `File not found: ${unit.target.relativePath}`,
                    });
                } else if (unit.search) {
                    try {
                        const content = fs.readFileSync(absolutePath, 'utf-8');
                        const occurrences = this._countOccurrences(content, unit.search);
                        if (occurrences === 0) {
                            issues.push({
                                unitId: unit.unitId,
                                issueType: 'search_not_found',
                                detail: `Search string not found in ${unit.target.relativePath}`,
                            });
                        } else if (occurrences > 1) {
                            issues.push({
                                unitId: unit.unitId,
                                issueType: 'search_found_multiple',
                                detail: `Search string found ${occurrences} times in ${unit.target.relativePath} — ambiguous patch`,
                            });
                        }
                    } catch {
                        // Non-fatal — will fail at apply time
                    }
                }
            } else if (unit.changeType === 'overwrite') {
                if (!exists) {
                    issues.push({
                        unitId: unit.unitId,
                        issueType: 'file_missing',
                        detail: `File not found for overwrite: ${unit.target.relativePath}`,
                    });
                }
            }
        }

        return {
            simulatedAt: new Date().toISOString(),
            allUnitsApplicable: issues.length === 0,
            issues,
        };
    }

    private _countOccurrences(haystack: string, needle: string): number {
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) {
            count++;
            pos += needle.length;
        }
        return count;
    }
}
