/**
 * campaignTemplates.ts — Phase 5.5 P5.5B
 *
 * Built-in campaign templates for common multi-step repair workflows.
 *
 * These are source-controlled TypeScript constants — never written at runtime.
 * They define the step structure and bounds for well-known repair patterns.
 *
 * Mirrors the pattern of recovery/defaults/recoveryPacks.ts.
 */

import type { CampaignStep, CampaignBounds, CampaignStepSource } from '../../../../../shared/repairCampaignTypes';
import { DEFAULT_CAMPAIGN_BOUNDS } from '../../../../../shared/repairCampaignTypes';

// ─── Template definition ──────────────────────────────────────────────────────

export interface CampaignTemplate {
    templateId: string;
    label: string;
    description: string;
    /** Primary subsystem this template targets. May be overridden at plan time. */
    defaultSubsystem: string;
    /** Step definitions (without campaignId / stepId — assigned at plan time). */
    stepDefinitions: Array<{
        order: number;
        label: string;
        scopeHint: string;
        source: CampaignStepSource;
        strategyHint?: string;
        verificationRequired: boolean;
        rollbackExpected: boolean;
        isOptional: boolean;
        prerequisites: number[]; // order indices of prerequisite steps
    }>;
    bounds: CampaignBounds;
}

// ─── Built-in templates ───────────────────────────────────────────────────────

export const BUILTIN_CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
    {
        templateId: 'bootstrap_wiring_repair',
        label: 'Bootstrap Wiring Repair',
        description: 'Fix bootstrap wiring → verify runtime registration → refresh dashboard state',
        defaultSubsystem: 'bootstrap',
        stepDefinitions: [
            {
                order: 0,
                label: 'Fix bootstrap wiring issue',
                scopeHint: 'bootstrap',
                source: 'repair_template',
                strategyHint: 'bootstrap_fix',
                verificationRequired: true,
                rollbackExpected: true,
                isOptional: false,
                prerequisites: [],
            },
            {
                order: 1,
                label: 'Verify runtime registration',
                scopeHint: 'runtime_registration',
                source: 'repair_template',
                strategyHint: 'runtime_verify',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [0],
            },
            {
                order: 2,
                label: 'Refresh dashboard state',
                scopeHint: 'dashboard',
                source: 'repair_template',
                strategyHint: 'dashboard_refresh',
                verificationRequired: false,
                rollbackExpected: false,
                isOptional: true,
                prerequisites: [1],
            },
        ],
        bounds: { ...DEFAULT_CAMPAIGN_BOUNDS, maxSteps: 3 },
    },

    {
        templateId: 'registry_defaults_repair',
        label: 'Registry / Defaults Repair',
        description: 'Repair registry/defaults path → rerun self-model refresh → re-run verification',
        defaultSubsystem: 'self_model',
        stepDefinitions: [
            {
                order: 0,
                label: 'Repair registry/defaults path',
                scopeHint: 'registry_defaults',
                source: 'repair_template',
                strategyHint: 'registry_repair',
                verificationRequired: true,
                rollbackExpected: true,
                isOptional: false,
                prerequisites: [],
            },
            {
                order: 1,
                label: 'Rerun self-model refresh',
                scopeHint: 'self_model',
                source: 'repair_template',
                strategyHint: 'self_model_refresh',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [0],
            },
            {
                order: 2,
                label: 'Re-run verification pass',
                scopeHint: 'verification',
                source: 'repair_template',
                strategyHint: 'verification_run',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [1],
            },
        ],
        bounds: { ...DEFAULT_CAMPAIGN_BOUNDS, maxSteps: 3 },
    },

    {
        templateId: 'config_correction_flow',
        label: 'Config Correction Flow',
        description: 'Apply config correction → run tests → if tests pass, run telemetry check',
        defaultSubsystem: 'config',
        stepDefinitions: [
            {
                order: 0,
                label: 'Apply config correction',
                scopeHint: 'config',
                source: 'repair_template',
                strategyHint: 'config_fix',
                verificationRequired: true,
                rollbackExpected: true,
                isOptional: false,
                prerequisites: [],
            },
            {
                order: 1,
                label: 'Run test verification',
                scopeHint: 'tests',
                source: 'repair_template',
                strategyHint: 'test_run',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [0],
            },
            {
                order: 2,
                label: 'Run telemetry health check',
                scopeHint: 'telemetry',
                source: 'repair_template',
                strategyHint: 'telemetry_check',
                verificationRequired: false,
                rollbackExpected: false,
                isOptional: true,
                prerequisites: [1],
            },
        ],
        bounds: { ...DEFAULT_CAMPAIGN_BOUNDS, maxSteps: 3 },
    },

    {
        templateId: 'provider_mapping_repair',
        label: 'Provider Mapping Repair',
        description: 'Fix provider mapping → validate diagnostics → resume autonomous goal execution',
        defaultSubsystem: 'inference',
        stepDefinitions: [
            {
                order: 0,
                label: 'Fix provider mapping',
                scopeHint: 'provider_mapping',
                source: 'repair_template',
                strategyHint: 'provider_fix',
                verificationRequired: true,
                rollbackExpected: true,
                isOptional: false,
                prerequisites: [],
            },
            {
                order: 1,
                label: 'Validate diagnostics',
                scopeHint: 'diagnostics',
                source: 'repair_template',
                strategyHint: 'diagnostics_validate',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [0],
            },
            {
                order: 2,
                label: 'Resume autonomous goal execution',
                scopeHint: 'autonomy',
                source: 'repair_template',
                strategyHint: 'autonomy_resume',
                verificationRequired: false,
                rollbackExpected: false,
                isOptional: true,
                prerequisites: [1],
            },
        ],
        bounds: { ...DEFAULT_CAMPAIGN_BOUNDS, maxSteps: 3 },
    },

    {
        templateId: 'multi_stage_high_complexity',
        label: 'Multi-Stage High-Complexity Repair',
        description: '4-stage bounded decomposition scaffold for high-complexity repairs',
        defaultSubsystem: 'general',
        stepDefinitions: [
            {
                order: 0,
                label: 'Prepare: analyze and validate preconditions',
                scopeHint: 'prepare',
                source: 'repair_template',
                strategyHint: 'prepare',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [],
            },
            {
                order: 1,
                label: 'Apply: incremental primary changes',
                scopeHint: 'apply_primary',
                source: 'repair_template',
                strategyHint: 'apply_primary',
                verificationRequired: true,
                rollbackExpected: true,
                isOptional: false,
                prerequisites: [0],
            },
            {
                order: 2,
                label: 'Verify: run checks and confirm state',
                scopeHint: 'verify',
                source: 'repair_template',
                strategyHint: 'verify',
                verificationRequired: true,
                rollbackExpected: false,
                isOptional: false,
                prerequisites: [1],
            },
            {
                order: 3,
                label: 'Finalize: confirm stable state',
                scopeHint: 'finalize',
                source: 'repair_template',
                strategyHint: 'finalize',
                verificationRequired: false,
                rollbackExpected: false,
                isOptional: true,
                prerequisites: [2],
            },
        ],
        bounds: { ...DEFAULT_CAMPAIGN_BOUNDS, maxSteps: 4 },
    },
];

/** Look up a built-in template by ID. Returns null if not found. */
export function getTemplateById(templateId: string): CampaignTemplate | null {
    return BUILTIN_CAMPAIGN_TEMPLATES.find(t => t.templateId === templateId) ?? null;
}
