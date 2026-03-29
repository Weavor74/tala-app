/**
 * defaultPolicy.ts — Bundled Governance Policy Defaults
 *
 * Phase 3.5 Self-Governance Foundation
 *
 * Source-authoritative default governance policy for the Tala governance layer.
 * Committed in source control; available on a fresh clone with no file placement.
 *
 * Design rules:
 * - This file is the authoritative source for the bundled default policy.
 * - The default tier is 'human_review_required' (fail-safe toward human oversight).
 * - Self-authorization is only permitted for explicitly allowlisted, minimal-risk changes.
 * - Protected subsystem changes always require at least human review.
 * - Changes touching the 'blocked' safetyClass always produce a 'blocked' tier.
 *
 * Runtime-generated or user-extended policies may live in
 * <dataDir>/governance/policy/active_policy.json but are never required for operation.
 */

import type { GovernancePolicy, GovernanceRule } from '../../../../shared/governanceTypes';

// ─── Rule Definitions ─────────────────────────────────────────────────────────

const RULES: GovernanceRule[] = [
    // ── Hard block: safetyClass 'blocked' ────────────────────────────────────
    {
        ruleId: 'GOV-BLOCKED',
        label: 'Safety Class Blocked',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'blocked' },
        ],
        requiredTier: 'blocked',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: false,
        rationale: 'Proposals with safetyClass "blocked" must never be auto-promoted or executed.',
    },

    // ── Hard block: protected subsystem + high risk ───────────────────────────
    {
        ruleId: 'GOV-PROT-HIGH',
        label: 'Protected Subsystem — High Risk',
        conditions: [
            { field: 'isProtectedSubsystem', operator: 'eq', value: true },
            { field: 'safetyClass', operator: 'in', value: ['high_risk', 'blocked'] },
        ],
        requiredTier: 'human_dual_approval',
        requiresManualConfirmation: true,
        escalateOnVerificationFailure: true,
        rationale: 'High-risk changes to protected subsystems require dual approval and manual confirmation.',
    },

    // ── Protected subsystem: any risk ────────────────────────────────────────
    {
        ruleId: 'GOV-PROT-SUBSYSTEM',
        label: 'Protected Subsystem',
        conditions: [
            { field: 'isProtectedSubsystem', operator: 'eq', value: true },
        ],
        requiredTier: 'protected_subsystem',
        requiresManualConfirmation: true,
        escalateOnVerificationFailure: true,
        rationale: 'Changes to protected subsystems require explicit human review.',
    },

    // ── Protected files ───────────────────────────────────────────────────────
    {
        ruleId: 'GOV-PROT-FILES',
        label: 'Protected Files Targeted',
        conditions: [
            { field: 'hasProtectedFile', operator: 'eq', value: true },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: true,
        escalateOnVerificationFailure: false,
        rationale: 'Proposals targeting protected files require manual review confirmation.',
    },

    // ── High risk safety class ────────────────────────────────────────────────
    {
        ruleId: 'GOV-HIGH-RISK',
        label: 'High Risk Safety Class',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'high_risk' },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: true,
        escalateOnVerificationFailure: true,
        rationale: 'High-risk proposals require human review and manual confirmation.',
    },

    // ── Invariant-sensitive changes ───────────────────────────────────────────
    {
        ruleId: 'GOV-INVARIANT',
        label: 'Invariant-Sensitive Change',
        conditions: [
            { field: 'hasInvariantSensitivity', operator: 'eq', value: true },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: true,
        rationale: 'Changes that threaten architectural invariants require human review.',
    },

    // ── Many files (≥ 5 files) ────────────────────────────────────────────────
    {
        ruleId: 'GOV-WIDE-SCOPE',
        label: 'Wide Scope (≥5 Files)',
        conditions: [
            { field: 'fileCount', operator: 'gte', value: 5 },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: false,
        rationale: 'Changes spanning 5 or more files require human review due to broad scope.',
    },

    // ── Safe-with-review + moderate files (3-4 files) ────────────────────────
    {
        ruleId: 'GOV-REVIEW-MODERATE',
        label: 'Safe-With-Review — Moderate Scope',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'safe_with_review' },
            { field: 'fileCount', operator: 'gte', value: 3 },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: false,
        rationale: 'Safe-with-review proposals spanning 3 or more files require human review.',
    },

    // ── Safe-with-review + manual verification ────────────────────────────────
    {
        ruleId: 'GOV-REVIEW-MANUAL-VERIFY',
        label: 'Safe-With-Review — Manual Verification Required',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'safe_with_review' },
            { field: 'verificationManualRequired', operator: 'eq', value: true },
        ],
        requiredTier: 'human_review_required',
        requiresManualConfirmation: true,
        escalateOnVerificationFailure: false,
        rationale: 'Proposals that require manual verification must also pass human governance review.',
    },

    // ── Safe-with-review + small scope → Tala self-standard ──────────────────
    {
        ruleId: 'GOV-SELF-STANDARD',
        label: 'Tala Self-Authorized — Standard Risk',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'safe_with_review' },
            { field: 'fileCount', operator: 'lte', value: 2 },
            { field: 'isProtectedSubsystem', operator: 'eq', value: false },
            { field: 'hasProtectedFile', operator: 'eq', value: false },
            { field: 'hasInvariantSensitivity', operator: 'eq', value: false },
            { field: 'verificationManualRequired', operator: 'eq', value: false },
        ],
        requiredTier: 'tala_self_standard',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: false,
        rationale: 'Small-scope safe-with-review proposals with no protection concerns may be self-authorized by Tala.',
    },

    // ── Safe-auto + minimal scope → Tala self-low-risk ───────────────────────
    {
        ruleId: 'GOV-SELF-LOW-RISK',
        label: 'Tala Self-Authorized — Low Risk',
        conditions: [
            { field: 'safetyClass', operator: 'eq', value: 'safe_auto' },
            { field: 'fileCount', operator: 'lte', value: 2 },
            { field: 'isProtectedSubsystem', operator: 'eq', value: false },
            { field: 'hasProtectedFile', operator: 'eq', value: false },
            { field: 'hasInvariantSensitivity', operator: 'eq', value: false },
        ],
        requiredTier: 'tala_self_low_risk',
        requiresManualConfirmation: false,
        escalateOnVerificationFailure: false,
        rationale: 'Minimal-scope safe-auto proposals with no protection concerns may be self-authorized by Tala at low-risk tier.',
    },
];

// ─── Default Policy ───────────────────────────────────────────────────────────

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
    policyId: 'default-v1',
    label: 'Tala Default Governance Policy',
    version: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    rules: RULES,
    // Fail-safe: if no rule matches, require human review
    defaultTier: 'human_review_required',
    // Self-authorization is enabled by default for explicitly allowlisted tiers
    selfAuthorizationDisabled: false,
};

// ─── Protected Subsystems ─────────────────────────────────────────────────────

/**
 * Subsystem IDs that are always considered protected for governance purposes.
 * Any proposal targeting these subsystems triggers at minimum the protected_subsystem tier.
 */
export const PROTECTED_SUBSYSTEMS: ReadonlyArray<string> = [
    'electron/services/router',
    'electron/services/soul',
    'electron/services/identity',
    'electron/services/selfModel',
    'electron/main',
    'electron/preload',
    'data/identity',
    'shared',
];
