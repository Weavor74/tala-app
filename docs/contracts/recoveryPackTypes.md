# Contract: recoveryPackTypes.ts

**Source**: [shared/recoveryPackTypes.ts](../../shared/recoveryPackTypes.ts)

## Interfaces

### `RecoveryPackScope`
```typescript
interface RecoveryPackScope {
    /**
     * Maximum number of files the pack may include in any proposal.
     * 0 means the pack takes in-memory/structural action only (no file writes).
     */
    maxFiles: number;
    /**
     * Subsystem IDs this pack is permitted to address.
     * Must not overlap with the AutonomyPolicy.hardBlockedSubsystems list.
     */
    allowedSubsystems: string[];
    /**
     * Optional explicit file path glob patterns the pack may touch.
     * Empty array means any file within the allowed subsystems is permitted
     * (up to maxFiles).
     */
    allowedFilePaths: string[];
}
```

### `RecoveryPackApplicabilityRule`
```typescript
interface RecoveryPackApplicabilityRule {
    ruleId: string;
    kind: RecoveryPackApplicabilityRuleKind;
    /**
     * The value to compare against.
     * - For goal_source_match: a GoalSource string (e.g. "repeated_execution_failure")
     * - For min_source_count: a numeric string (e.g. "3") representing a minimum count
     * - For keyword_in_title: a substring to search for (case-insensitive)
     * - For subsystem_id_match: an exact subsystem ID
     */
    matchValue: string;
    /** Weight contribution to total match score (0–100). */
    weight: number;
    /**
     * If true, this rule must match or the pack's score is zeroed.
     * Required rules are evaluated first; on any required-rule miss the pack is skipped.
     */
    required: boolean;
}
```

### `RecoveryPackActionTemplate`
```typescript
interface RecoveryPackActionTemplate {
    actionId: string;
    /** Human-readable description of what this action addresses. */
    description: string;
    /**
     * Target file path template. May use placeholders like {subsystemId}
```

### `RecoveryPackVerificationTemplate`
```typescript
interface RecoveryPackVerificationTemplate {
    verificationId: string;
    /** Human-readable description of what this check confirms. */
    description: string;
    /** Path or pattern to verify against. */
    targetPath: string;
    /** Whether failing this verification counts as a pack failure. */
    required: boolean;
}
```

### `RecoveryPackRollbackTemplate`
```typescript
interface RecoveryPackRollbackTemplate {
    rollbackId: string;
    /** Human-readable description of rollback expectation. */
    description: string;
    /** How rollback is handled for this pack's changes. */
    strategy: 'revert_patched_files' | 'no_rollback_needed' | 'manual_review_required';
    /**
     * Additional file paths to snapshot before applying, beyond the pack's
     * action template targets. Allows safe rollback of dependent files.
     */
    extraSnapshotPaths: string[];
}
```

### `RecoveryPackConfidence`
```typescript
interface RecoveryPackConfidence {
    /** Current computed confidence. 0.0–1.0. */
    current: number;
    /** Starting confidence for a freshly deployed pack. Typically 0.65. */
    initial: number;
    /** Floor below which the pack is disqualified. Default: 0.3. */
    floor: number;
    /** Ceiling above which confidence cannot rise further. Default: 0.95. */
    ceiling: number;
    /** Cumulative count of successful executions. */
    successCount: number;
    /** Cumulative count of failed executions. */
    failureCount: number;
    /** Cumulative count of rollbacks triggered. */
    rollbackCount: number;
    /** ISO timestamp of last confidence adjustment. */
    lastAdjustedAt?: string;
}
```

### `RecoveryPack`
```typescript
interface RecoveryPack {
    packId: RecoveryPackId;
    version: RecoveryPackVersion;
    label: string;
    description: string;
    /** Which GoalSource categories this pack is designed to address. */
    applicableGoalSources: string[];
    applicabilityRules: RecoveryPackApplicabilityRule[];
    scope: RecoveryPackScope;
    actionTemplates: RecoveryPackActionTemplate[];
    verificationTemplates: RecoveryPackVerificationTemplate[];
    rollbackTemplate: RecoveryPackRollbackTemplate;
    confidence: RecoveryPackConfidence;
    /** When false the pack is excluded from all matching. */
    enabled: boolean;
    /**
     * Maximum times this pack may be attempted for the same goalId before
     * the disqualifier triggers. Default: 2.
     */
    maxAttemptsPerGoal: number;
    /**
     * When true the pack is never selected for autonomous execution.
     * May only be used via human-initiated planning.
     */
    requiresHumanReview: boolean;
    /** ISO timestamp when this pack definition was committed to source. */
    committedAt: string;
}
```

### `RecoveryPackMatch`
```typescript
interface RecoveryPackMatch {
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    matchStrength: RecoveryPackMatchStrength;
    /** Total score from applicable rules. 0–100+. */
    matchScore: number;
    /** Rule IDs that contributed to the match score. */
    matchedRuleIds: string[];
    /** Human-readable explanation of why this pack was or was not selected. */
    rationale: string;
    /** Whether a disqualifying condition blocked this pack. */
    disqualified: boolean;
    /** The reason this pack was disqualified, if applicable. */
    disqualifyingReason?: string;
}
```

### `RecoveryPackMatchResult`
```typescript
interface RecoveryPackMatchResult {
    goalId: string;
    evaluatedAt: string;
    /** All packs evaluated, ordered by matchScore descending. */
    candidates: RecoveryPackMatch[];
    /** The packId selected for use, or null if no pack is suitable. */
    selectedPackId: RecoveryPackId | null;
    selectedMatchStrength: RecoveryPackMatchStrength;
    /**
     * True when no suitable pack was found and standard planning should proceed.
     * Always true when selectedPackId is null.
     */
    fallbackToStandardPlanning: boolean;
    /** Top-level rationale for the selection decision. */
    rationale: string;
}
```

### `RecoveryPackExecutionRecord`
```typescript
interface RecoveryPackExecutionRecord {
    recordId: string;
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    goalId: string;
    runId: string;
    startedAt: string;
    completedAt?: string;
    outcome: RecoveryPackExecutionOutcome;
    /** The proposal ID produced from this pack's templates, if any. */
    proposalId?: string;
    /** The execution run ID, if any. */
    executionRunId?: string;
    /** Whether a rollback was triggered. */
    rollbackTriggered: boolean;
    failureReason?: string;
    /** The pack's confidence.current at the moment the pack was used. */
    confidenceAtUse: number;
    /** The pack's confidence.current after outcome-based adjustment. */
    confidenceAfterAdjustment: number;
}
```

### `RecoveryPackOutcomeSummary`
```typescript
interface RecoveryPackOutcomeSummary {
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    label: string;
    currentConfidence: number;
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    rollbackCount: number;
    lastAttemptAt?: string;
    lastOutcome?: RecoveryPackExecutionOutcome;
    enabled: boolean;
}
```

### `RecoveryPackDashboardState`
```typescript
interface RecoveryPackDashboardState {
    /** All registered packs with their current outcome summaries. */
    registeredPacks: Array<{
        pack: RecoveryPack;
        summary: RecoveryPackOutcomeSummary;
    }
```

### `RecoveryPackId`
```typescript
type RecoveryPackId =  string;
```

### `RecoveryPackVersion`
```typescript
type RecoveryPackVersion =  string;
```

### `RecoveryPackApplicabilityRuleKind`
```typescript
type RecoveryPackApplicabilityRuleKind = 
    | 'goal_source_match'       // goal.source === matchValue (exact)
    | 'min_source_count'        // numeric count in sourceContext >= parseInt(matchValue)
    | 'keyword_in_title'        // goal.title.toLowerCase().includes(matchValue.toLowerCase())
    | 'subsystem_id_match';
```

### `RecoveryPackMatchStrength`
```typescript
type RecoveryPackMatchStrength =  'no_match' | 'weak_match' | 'strong_match';
```

### `RecoveryPackExecutionOutcome`
```typescript
type RecoveryPackExecutionOutcome = 
    | 'succeeded'
    | 'failed'
    | 'rolled_back'
    | 'governance_blocked'
    | 'aborted';
```

