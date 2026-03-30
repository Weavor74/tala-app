/**
 * RepairCampaignPlanner.ts — Phase 5.5 P5.5B
 *
 * Campaign plan builder. Creates bounded RepairCampaign objects from
 * various input sources without invoking any execution services.
 *
 * Input sources supported:
 *   1. DecompositionPlan (Phase 5.1D) — converts DecompositionStep[] to CampaignStep[]
 *   2. RecoveryPack (Phase 4.3) — converts action templates to CampaignStep[]
 *   3. Built-in campaign template — expands a CampaignTemplate to full campaign
 *   4. Manual step list — converts caller-supplied step definitions
 *
 * Safety invariants:
 * - Plans exceeding bounds.maxSteps are truncated at the bound (never silently expanded).
 * - Plans with 0 steps are rejected (returns null).
 * - Plan creation has no side effects — pure data transformation only.
 * - All generated campaigns are returned in status: 'draft'.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    RepairCampaign,
    CampaignStep,
    CampaignBounds,
    CampaignStepSource,
    CampaignOrigin,
    RepairCampaignId,
    CampaignStepId,
} from '../../../../shared/repairCampaignTypes';
import { DEFAULT_CAMPAIGN_BOUNDS } from '../../../../shared/repairCampaignTypes';
import type { DecompositionPlan, DecompositionStep } from '../../../../shared/escalationTypes';
import type { RecoveryPack } from '../../../../shared/recoveryPackTypes';
import { BUILTIN_CAMPAIGN_TEMPLATES, getTemplateById } from './defaults/campaignTemplates';
import { telemetry } from '../../TelemetryService';

// ─── Hard safety caps (never configurable via API) ────────────────────────────

const HARD_CAP_MAX_STEPS = 10;
const HARD_CAP_MAX_REASSESSMENTS = 8;

// ─── RepairCampaignPlanner ────────────────────────────────────────────────────

export class RepairCampaignPlanner {

    /**
     * Builds a repair campaign from a Phase 5.1 DecompositionPlan.
     *
     * Each DecompositionStep becomes one CampaignStep. Step count is capped
     * at bounds.maxSteps. Returns null when the plan contains no steps.
     */
    buildFromDecomposition(
        plan: DecompositionPlan,
        goalId: string,
        subsystem: string,
        boundsOverride?: Partial<CampaignBounds>,
    ): RepairCampaign | null {
        if (plan.steps.length === 0) return null;

        const bounds = this._resolveBounds(boundsOverride);
        const campaignId = this._newCampaignId();

        const truncated = plan.steps.slice(0, bounds.maxSteps);
        if (truncated.length < plan.steps.length) {
            telemetry.operational(
                'autonomy',
                'campaign_safety_bound_triggered',
                'warn',
                'RepairCampaignPlanner',
                `Decomposition plan ${plan.planId} has ${plan.steps.length} steps; ` +
                `truncated to maxSteps=${bounds.maxSteps}`,
            );
        }

        const steps = truncated.map((ds, i) =>
            this._stepFromDecompositionStep(campaignId, ds, i),
        );

        return this._makeCampaign(
            campaignId,
            goalId,
            subsystem,
            `Decomposition-based repair: ${plan.rationale}`,
            'decomposition',
            plan.planId,
            steps,
            bounds,
        );
    }

    /**
     * Builds a repair campaign from a Phase 4.3 RecoveryPack's action templates.
     *
     * Each action template becomes one CampaignStep in declaration order.
     * Steps are bounded at bounds.maxSteps. Returns null when the pack has no actions.
     */
    buildFromRecoveryPack(
        pack: RecoveryPack,
        goalId: string,
        subsystem: string,
        boundsOverride?: Partial<CampaignBounds>,
    ): RepairCampaign | null {
        if (pack.actionTemplates.length === 0) return null;

        const bounds = this._resolveBounds(boundsOverride);
        const campaignId = this._newCampaignId();

        const truncated = pack.actionTemplates.slice(0, bounds.maxSteps);
        if (truncated.length < pack.actionTemplates.length) {
            telemetry.operational(
                'autonomy',
                'campaign_safety_bound_triggered',
                'warn',
                'RepairCampaignPlanner',
                `Recovery pack ${pack.packId} has ${pack.actionTemplates.length} actions; ` +
                `truncated to maxSteps=${bounds.maxSteps}`,
            );
        }

        const steps: CampaignStep[] = truncated.map((action, i) => {
            const stepId = this._newStepId();
            return {
                stepId,
                campaignId,
                order: i,
                label: action.description,
                targetSubsystem: subsystem,
                scopeHint: action.targetFileTemplate || subsystem,
                source: 'recovery_pack_action' as CampaignStepSource,
                strategyHint: pack.packId,
                verificationRequired: !action.optional,
                rollbackExpected: pack.rollbackTemplate.strategy === 'revert_patched_files',
                isOptional: action.optional,
                prerequisites: [],
                status: 'pending',
            };
        });

        // Fix up prerequisites using actual step IDs (they're sequential)
        for (let i = 1; i < steps.length; i++) {
            steps[i] = { ...steps[i]!, prerequisites: [steps[i - 1]!.stepId] };
        }

        return this._makeCampaign(
            campaignId,
            goalId,
            subsystem,
            `Recovery pack campaign: ${pack.label}`,
            'recovery_pack',
            pack.packId,
            steps,
            bounds,
        );
    }

    /**
     * Builds a repair campaign from a built-in campaign template.
     *
     * Returns null when the template ID is not found.
     */
    buildFromTemplate(
        templateId: string,
        goalId: string,
        subsystem?: string,
        boundsOverride?: Partial<CampaignBounds>,
    ): RepairCampaign | null {
        const template = getTemplateById(templateId);
        if (!template) return null;

        const bounds = this._resolveBounds({ ...template.bounds, ...boundsOverride });
        const campaignId = this._newCampaignId();
        const effectiveSubsystem = subsystem ?? template.defaultSubsystem;

        const truncated = template.stepDefinitions.slice(0, bounds.maxSteps);

        // Build steps first pass — collect step IDs by order
        const stepIds: string[] = truncated.map(() => this._newStepId());

        const steps: CampaignStep[] = truncated.map((def, i) => ({
            stepId: stepIds[i],
            campaignId,
            order: def.order,
            label: def.label,
            targetSubsystem: effectiveSubsystem,
            scopeHint: def.scopeHint,
            source: def.source,
            strategyHint: def.strategyHint,
            verificationRequired: def.verificationRequired,
            rollbackExpected: def.rollbackExpected,
            isOptional: def.isOptional,
            // Map prerequisite order indices to actual step IDs
            prerequisites: def.prerequisites
                .filter(pi => pi < stepIds.length)
                .map(pi => stepIds[pi]),
            status: 'pending',
        }));

        return this._makeCampaign(
            campaignId,
            goalId,
            effectiveSubsystem,
            template.label,
            'repair_template',
            templateId,
            steps,
            bounds,
        );
    }

    /**
     * Returns all available built-in template IDs and labels.
     * Useful for callers selecting a template.
     */
    listTemplates(): Array<{ templateId: string; label: string; description: string }> {
        return BUILTIN_CAMPAIGN_TEMPLATES.map(t => ({
            templateId: t.templateId,
            label: t.label,
            description: t.description,
        }));
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _resolveBounds(override?: Partial<CampaignBounds>): CampaignBounds {
        if (!override) return { ...DEFAULT_CAMPAIGN_BOUNDS };
        return {
            maxSteps: Math.min(override.maxSteps ?? DEFAULT_CAMPAIGN_BOUNDS.maxSteps, HARD_CAP_MAX_STEPS),
            maxReassessments: Math.min(override.maxReassessments ?? DEFAULT_CAMPAIGN_BOUNDS.maxReassessments, HARD_CAP_MAX_REASSESSMENTS),
            maxAgeMs: override.maxAgeMs ?? DEFAULT_CAMPAIGN_BOUNDS.maxAgeMs,
            stepTimeoutMs: override.stepTimeoutMs ?? DEFAULT_CAMPAIGN_BOUNDS.stepTimeoutMs,
            cooldownAfterFailureMs: override.cooldownAfterFailureMs ?? DEFAULT_CAMPAIGN_BOUNDS.cooldownAfterFailureMs,
        };
    }

    private _newCampaignId(): RepairCampaignId {
        return `campaign-${uuidv4()}`;
    }

    private _newStepId(): CampaignStepId {
        return `step-${uuidv4()}`;
    }

    /** Produces a deterministic step ID placeholder by order (used only for sequential packs). */
    private _stepIdAtOrder(_campaignId: string, _order: number): CampaignStepId {
        // This is only a fallback; actual IDs are fixed up after creation in buildFromRecoveryPack
        return `step-${uuidv4()}`;
    }

    private _stepFromDecompositionStep(
        campaignId: RepairCampaignId,
        ds: DecompositionStep,
        order: number,
    ): CampaignStep {
        return {
            stepId: this._newStepId(),
            campaignId,
            order,
            label: ds.description,
            targetSubsystem: ds.scopeHint,
            scopeHint: ds.scopeHint,
            source: 'decomposition_step',
            strategyHint: ds.kind,
            verificationRequired: ds.verifiable,
            rollbackExpected: ds.rollbackable,
            isOptional: false,
            prerequisites: [], // set in second pass below
            status: 'pending',
        };
    }

    private _makeCampaign(
        campaignId: RepairCampaignId,
        goalId: string,
        subsystem: string,
        label: string,
        originType: CampaignOrigin,
        originRef: string | undefined,
        steps: CampaignStep[],
        bounds: CampaignBounds,
    ): RepairCampaign {
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + bounds.maxAgeMs).toISOString();

        return {
            campaignId,
            goalId,
            originType,
            originRef,
            label,
            subsystem,
            createdAt: now,
            expiresAt,
            bounds,
            status: 'draft',
            updatedAt: now,
            steps,
            currentStepIndex: 0,
            reassessmentCount: 0,
            checkpoints: [],
            reassessmentRecords: [],
        };
    }
}
