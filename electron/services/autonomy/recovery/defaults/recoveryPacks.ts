/**
 * recoveryPacks.ts — Phase 4.3 Built-in Recovery Pack Definitions
 *
 * P4.3B: Source-controlled pack registry.
 *
 * These packs are committed to source. They are immutable definitions.
 * The only mutable state is confidence.current, which is stored in
 * <dataDir>/autonomy/recovery/confidence.json by RecoveryPackRegistry.
 *
 * Initial pack set: 4 conservative, high-confidence packs.
 * Each pack covers a well-understood, bounded failure class.
 *
 * Selection criteria for initial set:
 * - Only GoalSource categories with clear, bounded repair strategies
 * - maxFiles ≤ 3 (conservative scope limit)
 * - requiresHumanReview: false only when the repair pattern is safe and well-understood
 * - initialConfidence: 0.65 (conservative — trust is earned through outcomes)
 */

import type { RecoveryPack } from '../../../../../shared/recoveryPackTypes';

export const BUILTIN_RECOVERY_PACKS: RecoveryPack[] = [

    // ─── Pack 1: Repeated Execution Failure ────────────────────────────────────
    // Applies when the same subsystem has experienced repeated execution failures.
    // Proposes a bounded investigation of the subsystem's execution configuration.
    {
        packId: 'repeated_execution_failure_v1',
        version: '1.0.0',
        label: 'Repeated Execution Failure',
        description:
            'Addresses a subsystem that has experienced repeated controlled-execution failures. ' +
            'Proposes bounded investigation of the subsystem\'s execution configuration and ' +
            'verification pipeline to identify the root cause of repeated failures.',
        applicableGoalSources: ['repeated_execution_failure'],
        applicabilityRules: [
            {
                ruleId: 'source-match',
                kind: 'goal_source_match',
                matchValue: 'repeated_execution_failure',
                weight: 70,
                required: true,
            },
            {
                ruleId: 'min-failures',
                kind: 'min_source_count',
                matchValue: '3',
                weight: 20,
                required: false,
            },
        ],
        scope: {
            maxFiles: 2,
            allowedSubsystems: [],    // empty = any non-blocked subsystem
            allowedFilePaths: [],     // empty = no file-level restriction beyond maxFiles
        },
        actionTemplates: [
            {
                actionId: 'investigate-execution-config',
                description:
                    'Investigate subsystem execution configuration for misconfigured ' +
                    'eligibility gates, stale run state, or verification mismatches.',
                targetFileTemplate: 'electron/services/execution/{subsystemId}',
                patchDescriptor: {
                    changeKind: 'configuration_investigation',
                    maxChanges: 1,
                },
                optional: false,
            },
        ],
        verificationTemplates: [
            {
                verificationId: 'verify-no-active-stale-runs',
                description: 'Verify that no stale active runs remain for the subsystem.',
                targetPath: 'electron/services/execution/ExecutionRunRegistry.ts',
                required: true,
            },
        ],
        rollbackTemplate: {
            rollbackId: 'rollback-execution-config',
            description: 'Revert any configuration changes to the subsystem execution layer.',
            strategy: 'revert_patched_files',
            extraSnapshotPaths: [],
        },
        confidence: {
            current: 0.65,
            initial: 0.65,
            floor: 0.3,
            ceiling: 0.95,
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
        },
        enabled: true,
        maxAttemptsPerGoal: 2,
        requiresHumanReview: false,
        committedAt: '2026-03-29T00:00:00.000Z',
    },

    // ─── Pack 2: Failed Verification ──────────────────────────────────────────
    // Applies when an execution run has failed its verification step.
    // Proposes a bounded review of the verification requirements for the subsystem.
    {
        packId: 'failed_verification_v1',
        version: '1.0.0',
        label: 'Failed Verification',
        description:
            'Addresses a subsystem where execution ran but verification failed. ' +
            'Proposes a bounded review of the verification requirements and ' +
            'configuration to determine why verification did not pass.',
        applicableGoalSources: ['failed_verification'],
        applicabilityRules: [
            {
                ruleId: 'source-match',
                kind: 'goal_source_match',
                matchValue: 'failed_verification',
                weight: 70,
                required: true,
            },
        ],
        scope: {
            maxFiles: 2,
            allowedSubsystems: [],
            allowedFilePaths: [],
        },
        actionTemplates: [
            {
                actionId: 'review-verification-requirements',
                description:
                    'Review verification requirements for the subsystem to identify ' +
                    'misconfigured or overly strict verification thresholds.',
                targetFileTemplate: 'electron/services/reflection/VerificationRequirementsEngine.ts',
                patchDescriptor: {
                    changeKind: 'verification_configuration_review',
                    maxChanges: 1,
                },
                optional: false,
            },
        ],
        verificationTemplates: [
            {
                verificationId: 'verify-requirements-engine-intact',
                description: 'Verify VerificationRequirementsEngine compiles without errors.',
                targetPath: 'electron/services/reflection/VerificationRequirementsEngine.ts',
                required: true,
            },
        ],
        rollbackTemplate: {
            rollbackId: 'rollback-verification-config',
            description: 'Revert any changes to verification requirements configuration.',
            strategy: 'revert_patched_files',
            extraSnapshotPaths: [],
        },
        confidence: {
            current: 0.65,
            initial: 0.65,
            floor: 0.3,
            ceiling: 0.95,
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
        },
        enabled: true,
        maxAttemptsPerGoal: 2,
        requiresHumanReview: false,
        committedAt: '2026-03-29T00:00:00.000Z',
    },

    // ─── Pack 3: Repeated Governance Block ────────────────────────────────────
    // Applies when proposals for the same subsystem keep getting blocked by governance.
    // Proposes a bounded review of the governance policy configuration.
    {
        packId: 'repeated_governance_block_v1',
        version: '1.0.0',
        label: 'Repeated Governance Block',
        description:
            'Addresses a pattern where proposals for the same subsystem are repeatedly ' +
            'blocked by governance policy. Proposes bounded review of the governance ' +
            'policy configuration for that subsystem to identify overly restrictive rules.',
        applicableGoalSources: ['repeated_governance_block'],
        applicabilityRules: [
            {
                ruleId: 'source-match',
                kind: 'goal_source_match',
                matchValue: 'repeated_governance_block',
                weight: 70,
                required: true,
            },
            {
                ruleId: 'min-blocks',
                kind: 'min_source_count',
                matchValue: '2',
                weight: 20,
                required: false,
            },
        ],
        scope: {
            maxFiles: 1,
            allowedSubsystems: [],
            allowedFilePaths: [
                'electron/services/governance/defaults/defaultPolicy.ts',
            ],
        },
        actionTemplates: [
            {
                actionId: 'review-governance-policy',
                description:
                    'Review governance policy defaults for the affected subsystem ' +
                    'to identify misconfigured authority tiers or confirmation requirements.',
                targetFileTemplate: 'electron/services/governance/defaults/defaultPolicy.ts',
                patchDescriptor: {
                    changeKind: 'governance_policy_review',
                    maxChanges: 1,
                },
                optional: false,
            },
        ],
        verificationTemplates: [
            {
                verificationId: 'verify-governance-policy-intact',
                description: 'Verify governance policy file compiles and structure is valid.',
                targetPath: 'electron/services/governance/defaults/defaultPolicy.ts',
                required: true,
            },
        ],
        rollbackTemplate: {
            rollbackId: 'rollback-governance-policy',
            description: 'Revert any changes to the governance policy defaults.',
            strategy: 'revert_patched_files',
            extraSnapshotPaths: [],
        },
        confidence: {
            current: 0.65,
            initial: 0.65,
            floor: 0.3,
            ceiling: 0.95,
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
        },
        enabled: true,
        maxAttemptsPerGoal: 2,
        requiresHumanReview: false,
        committedAt: '2026-03-29T00:00:00.000Z',
    },

    // ─── Pack 4: Recurring Reflection Goal ────────────────────────────────────
    // Applies when the same improvement goal recurs repeatedly without resolution.
    // Proposes bounded investigation of why the goal keeps appearing.
    {
        packId: 'recurring_reflection_goal_v1',
        version: '1.0.0',
        label: 'Recurring Reflection Goal',
        description:
            'Addresses a goal that has recurred multiple times without being resolved. ' +
            'Proposes bounded investigation of the subsystem to understand why the ' +
            'same issue keeps appearing and identify a structural fix.',
        applicableGoalSources: ['recurring_reflection_goal'],
        applicabilityRules: [
            {
                ruleId: 'source-match',
                kind: 'goal_source_match',
                matchValue: 'recurring_reflection_goal',
                weight: 70,
                required: true,
            },
            {
                ruleId: 'min-recurrence',
                kind: 'min_source_count',
                matchValue: '2',
                weight: 20,
                required: false,
            },
        ],
        scope: {
            maxFiles: 3,
            allowedSubsystems: [],
            allowedFilePaths: [],
        },
        actionTemplates: [
            {
                actionId: 'investigate-recurring-issue',
                description:
                    'Investigate the subsystem to identify why the same issue recurs. ' +
                    'Focus on structural configuration, missing integrations, or ' +
                    'persistent state that may be causing the recurrence.',
                targetFileTemplate: 'electron/services/{subsystemId}',
                patchDescriptor: {
                    changeKind: 'recurring_issue_investigation',
                    maxChanges: 2,
                },
                optional: false,
            },
        ],
        verificationTemplates: [
            {
                verificationId: 'verify-subsystem-compiles',
                description: 'Verify subsystem files compile without TypeScript errors.',
                targetPath: 'electron/services/{subsystemId}',
                required: true,
            },
        ],
        rollbackTemplate: {
            rollbackId: 'rollback-recurring-fix',
            description: 'Revert any structural changes made to the subsystem.',
            strategy: 'revert_patched_files',
            extraSnapshotPaths: [],
        },
        confidence: {
            current: 0.65,
            initial: 0.65,
            floor: 0.3,
            ceiling: 0.95,
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
        },
        enabled: true,
        maxAttemptsPerGoal: 2,
        requiresHumanReview: false,
        committedAt: '2026-03-29T00:00:00.000Z',
    },
];
