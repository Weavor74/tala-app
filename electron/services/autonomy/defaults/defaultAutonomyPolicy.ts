/**
 * defaultAutonomyPolicy.ts — Phase 4 Default Autonomy Policy
 *
 * Safe defaults for the autonomy layer.
 *
 * IMPORTANT: globalAutonomyEnabled defaults to FALSE.
 * The operator must explicitly enable autonomy via the dashboard toggle.
 *
 * All category policies default to disabled.
 * Individual categories may be enabled by the operator via policy update.
 *
 * Budget defaults are conservative:
 *   - 5 runs per hour maximum
 *   - 1 concurrent run globally
 *   - 15-minute failure cooldown, 30-minute governance-block cooldown
 *   - max 3 attempts per pattern before human review routing
 */

import type { AutonomyPolicy } from '../../../../shared/autonomyTypes';

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
    policyId: 'default_autonomy_policy_v1',
    label: 'Default Autonomy Policy (Conservative)',
    version: '1.0.0',

    // ── Global toggle — OFF by default ────────────────────────────────────────
    // The operator must explicitly enable via the Reflection Dashboard.
    globalAutonomyEnabled: false,

    // ── Budget ────────────────────────────────────────────────────────────────
    budget: {
        maxRunsPerPeriod: 5,
        periodMs: 60 * 60 * 1000,                  // 1 hour rolling window
        maxConcurrentRuns: 1,
        maxConcurrentRunsPerSubsystem: 1,
        failureCooldownMs: 15 * 60 * 1000,          // 15 min after failure
        governanceBlockCooldownMs: 30 * 60 * 1000,  // 30 min after governance block
        rollbackCooldownMs: 60 * 60 * 1000,         // 60 min after rollback
        maxAttemptsPerPattern: 3,                   // human review after 3 failures
    },

    // ── Category policies — all disabled by default ───────────────────────────
    categoryPolicies: [
        {
            categoryId: 'telemetry_anomaly',
            label: 'Telemetry Anomaly',
            autonomyEnabled: false,
            maxRiskScore: 30,
            maxFileScope: 3,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'repeated_execution_failure',
            label: 'Repeated Execution Failure',
            autonomyEnabled: false,
            maxRiskScore: 25,
            maxFileScope: 2,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'repeated_governance_block',
            label: 'Repeated Governance Block',
            autonomyEnabled: false,
            maxRiskScore: 20,
            maxFileScope: 2,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'stale_subsystem',
            label: 'Stale Subsystem',
            autonomyEnabled: false,
            maxRiskScore: 35,
            maxFileScope: 5,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'failed_verification',
            label: 'Failed Verification',
            autonomyEnabled: false,
            maxRiskScore: 20,
            maxFileScope: 2,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'recurring_reflection_goal',
            label: 'Recurring Reflection Goal',
            autonomyEnabled: false,
            maxRiskScore: 40,
            maxFileScope: 5,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'weak_coverage_signal',
            label: 'Weak Test Coverage Signal',
            autonomyEnabled: false,
            maxRiskScore: 30,
            maxFileScope: 4,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'unresolved_backlog_item',
            label: 'Unresolved Backlog Item',
            autonomyEnabled: false,
            maxRiskScore: 35,
            maxFileScope: 5,
            allowProtectedSubsystems: false,
        },
        {
            categoryId: 'user_seeded',
            label: 'User-Seeded Goal',
            autonomyEnabled: false,
            maxRiskScore: 50,
            maxFileScope: 10,
            allowProtectedSubsystems: false,
        },
    ],

    // ── Hard-blocked subsystems ───────────────────────────────────────────────
    // These subsystems may never be touched by autonomous action.
    hardBlockedSubsystems: [
        'identity',
        'soul',
        'governance',
        'security',
        'auth',
    ],
};
