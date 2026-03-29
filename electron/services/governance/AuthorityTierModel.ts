/**
 * AuthorityTierModel.ts — Phase 3.5 P3.5B
 *
 * Pure, stateless authority tier model.
 *
 * No external dependencies, no I/O, no async.
 * All functions are deterministic — same input always yields same result.
 *
 * Tier ordering (numeric priority, higher = more restrictive):
 *   tala_self_low_risk       = 1
 *   tala_self_standard       = 2
 *   protected_subsystem      = 3
 *   human_review_required    = 4
 *   human_dual_approval      = 5
 *   emergency_manual_only    = 6
 *   blocked                  = 7
 */

import type { AuthorityTier } from '../../../shared/governanceTypes';

// ─── Tier Priority Map ────────────────────────────────────────────────────────

const TIER_PRIORITY: Record<AuthorityTier, number> = {
    tala_self_low_risk:    1,
    tala_self_standard:    2,
    protected_subsystem:   3,
    human_review_required: 4,
    human_dual_approval:   5,
    emergency_manual_only: 6,
    blocked:               7,
};

const TIER_LABELS: Record<AuthorityTier, string> = {
    tala_self_low_risk:    'Tala Self-Authorized (Low Risk)',
    tala_self_standard:    'Tala Self-Authorized (Standard)',
    protected_subsystem:   'Protected Subsystem — Human Review Required',
    human_review_required: 'Human Review Required',
    human_dual_approval:   'Dual Human Approval Required',
    emergency_manual_only: 'Emergency Manual Override Only',
    blocked:               'Blocked — No Execution Permitted',
};

// ─── Exported utilities ───────────────────────────────────────────────────────

/**
 * Returns the numeric priority for a tier.
 * Higher value = more restrictive.
 */
export function tierPriority(tier: AuthorityTier): number {
    return TIER_PRIORITY[tier] ?? 0;
}

/**
 * Returns the human-readable label for a tier.
 */
export function tierLabel(tier: AuthorityTier): string {
    return TIER_LABELS[tier] ?? tier;
}

/**
 * Given a list of tiers, returns the most restrictive one.
 * If the list is empty, returns 'human_review_required' as the fail-safe default.
 */
export function mostRestrictiveTier(tiers: AuthorityTier[]): AuthorityTier {
    if (tiers.length === 0) return 'human_review_required';
    return tiers.reduce((current, candidate) =>
        TIER_PRIORITY[candidate] > TIER_PRIORITY[current] ? candidate : current,
    );
}

/**
 * Returns true when the tier allows Tala to self-authorize execution.
 * Only explicitly allowed tiers return true.
 */
export function tierAllowsSelfAuthorization(tier: AuthorityTier): boolean {
    return tier === 'tala_self_low_risk' || tier === 'tala_self_standard';
}

/**
 * Returns true when the tier requires at least one human approval record.
 */
export function tierRequiresHumanApproval(tier: AuthorityTier): boolean {
    return (
        tier === 'human_review_required' ||
        tier === 'human_dual_approval' ||
        tier === 'protected_subsystem' ||
        tier === 'emergency_manual_only'
    );
}

/**
 * Returns true when the tier requires two distinct human approval records.
 */
export function tierRequiresDualApproval(tier: AuthorityTier): boolean {
    return tier === 'human_dual_approval';
}

/**
 * Returns true when the tier hard-blocks execution with no approval path.
 */
export function isBlocked(tier: AuthorityTier): boolean {
    return tier === 'blocked' || tier === 'emergency_manual_only';
}

/**
 * Returns the number of distinct human approvals required for a tier.
 *
 *   blocked / emergency_manual_only  → 0 (no approval path; blocked)
 *   tala_self_*                      → 0 (self-authorization path)
 *   protected_subsystem              → 1
 *   human_review_required            → 1
 *   human_dual_approval              → 2
 */
export function approvalsRequired(tier: AuthorityTier): number {
    switch (tier) {
        case 'tala_self_low_risk':
        case 'tala_self_standard':
        case 'blocked':
        case 'emergency_manual_only':
            return 0;
        case 'protected_subsystem':
        case 'human_review_required':
            return 1;
        case 'human_dual_approval':
            return 2;
        default:
            return 1; // safe default
    }
}

/**
 * Returns all defined authority tiers in order from least to most restrictive.
 */
export function allTiersOrdered(): AuthorityTier[] {
    return [
        'tala_self_low_risk',
        'tala_self_standard',
        'protected_subsystem',
        'human_review_required',
        'human_dual_approval',
        'emergency_manual_only',
        'blocked',
    ];
}
