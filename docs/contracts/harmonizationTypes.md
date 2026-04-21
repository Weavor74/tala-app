# Contract: harmonizationTypes.ts

**Source**: [shared\harmonizationTypes.ts](../../shared/harmonizationTypes.ts)

## Interfaces

### `HarmonizationDetectionHint`
```typescript
interface HarmonizationDetectionHint {
    readonly hintKind: HarmonizationDetectionHintKind;
    readonly label: string;
    readonly pattern: string;
    readonly expectMatch: boolean;
    readonly weight: number;
}
```

### `HarmonizationCanonRule`
```typescript
interface HarmonizationCanonRule {
    readonly ruleId: HarmonizationRuleId;
    readonly label: string;
    readonly description: string;
    readonly patternClass: HarmonizationPatternClass;
    readonly riskLevel: HarmonizationRiskLevel;
    /**
     * Glob-style partial path segments used to narrow which files are scanned.
     * The scanner checks whether a file path includes at least one of these segments.
     */
    readonly scopePathIncludes: readonly string[];
    /**
     * Subsystem labels this rule applies to.
     * Used by the matcher to filter candidates by subsystem.
     */
    readonly applicableSubsystems: readonly string[];
    /**
     * Human-readable description of what a compliant implementation looks like.
     * Must be concrete — naming actual patterns, not aesthetics.
     */
    readonly complianceDescription: string;
    /**
     * Deterministic detection hints for the scanner.
     * All hints must fire for drift to be recorded.
     */
    readonly detectionHints: readonly HarmonizationDetectionHint[];
    /**
     * Conditions under which this rule must NOT be applied
     * even when drift is detected.
     */
    readonly exclusionConditions: readonly string[];
    /**
     * Minimum computed drift severity (0–100) required to emit a DriftRecord.
     * Prevents trivial single-instance differences from triggering campaigns.
     */
    readonly minDriftSeverity: number;

    // ── Runtime fields (persisted; populated from override layer at load) ──────
    status: HarmonizationRuleStatus;
    /** Current confidence in this rule's safety. 0–1. Adjusted by outcomes. */
    confidenceCurrent: number;
    /** Floor below which confidence cannot fall. */
    confidenceFloor: number;
    /** Ceiling above which confidence cannot rise. */
    confidenceCeiling: number;
    successCount: number;
    failureCount: number;
    regressionCount: number;
    lastAdjustedAt?: string; // ISO-8601
}
```

### `HarmonizationDriftRecord`
```typescript
interface HarmonizationDriftRecord {
    readonly driftId: HarmonizationDriftId;
    /** Canon rule this drift was evaluated against. */
    readonly ruleId: HarmonizationRuleId;
    readonly patternClass: HarmonizationPatternClass;
    readonly detectedAt: string; // ISO-8601
    /** File paths in which drift evidence was found. */
    readonly affectedFiles: readonly string[];
    /** Subsystems that own the affected files. */
    readonly affectedSubsystems: readonly string[];
    /**
     * Computed severity 0–100.
     * Based on: hint weights, violation coverage, affected file count.
     */
    readonly driftSeverity: number;
    /** Human-readable summary of what was detected. */
    readonly summary: string;
    /** Per-hint result for full inspectability. */
    readonly hintResults: readonly HarmonizationHintResult[];
    /** True if any affected file is in a protected subsystem. */
    readonly touchesProtectedSubsystem: boolean;
}
```

### `HarmonizationHintResult`
```typescript
interface HarmonizationHintResult {
    readonly hintLabel: string;
    readonly filePath: string;
    readonly passed: boolean;
    readonly detail?: string;
}
```

### `HarmonizationMatch`
```typescript
interface HarmonizationMatch {
    readonly matchId: string;
    readonly driftId: HarmonizationDriftId;
    readonly ruleId: HarmonizationRuleId;
    readonly matchedAt: string; // ISO-8601
    readonly strength: HarmonizationMatchStrength;
    /** Confidence inherited from the matched rule. */
    readonly matchConfidence: number;
    /** Whether all pre-campaign safety checks passed. */
    readonly safetyApproved: boolean;
    /** Reason safety was not approved (when safetyApproved=false). */
    readonly safetyBlockReason?: string;
    /** Reasons the match is weak or disqualified. */
    readonly disqualifiers: readonly string[];
    /** Derived scope for the harmonization campaign. */
    readonly proposedScope: HarmonizationScope;
}
```

### `HarmonizationScope`
```typescript
interface HarmonizationScope {
    /** Single subsystem this campaign is limited to. */
    readonly targetSubsystem: string;
    /** Exact file paths that will be touched. */
    readonly targetFiles: readonly string[];
    /** Pattern class being addressed (always exactly 1). */
    readonly patternClass: HarmonizationPatternClass;
    /** Human-readable description of the intended convergence. */
    readonly intendedConvergence: string;
    /** Files explicitly excluded (protected or out-of-bounds). */
    readonly excludedFiles: readonly string[];
}
```

### `HarmonizationCampaignInput`
```typescript
interface HarmonizationCampaignInput {
    readonly matchId: string;
    readonly driftId: HarmonizationDriftId;
    readonly ruleId: HarmonizationRuleId;
    readonly scope: HarmonizationScope;
    readonly riskLevel: HarmonizationRiskLevel;
    readonly verificationRequirements: readonly string[];
    readonly rollbackExpected: boolean;
    /** Skip and produce a 'skipped' campaign when confidence is too low. */
    readonly skipIfLowConfidence: boolean;
}
```

### `HarmonizationProposalMetadata`
```typescript
interface HarmonizationProposalMetadata {
    readonly campaignId: HarmonizationCampaignId;
    readonly ruleId: HarmonizationRuleId;
    readonly patternClass: HarmonizationPatternClass;
    readonly driftSeverity: number;
    readonly intendedConvergence: string;
    readonly targetFile: string;
    readonly riskLevel: HarmonizationRiskLevel;
}
```

### `HarmonizationCampaignBounds`
```typescript
interface HarmonizationCampaignBounds {
    /** Maximum files per campaign. */
    maxFiles: number;
    /** Maximum pattern classes per campaign (always 1). */
    maxPatternClasses: number;
    /** Maximum steps per campaign. */
    maxSteps: number;
    /** Maximum campaign age before auto-expiry. */
    maxAgeMs: number;
    /** Per-step timeout. */
    stepTimeoutMs: number;
    /** Cooldown after failure or rollback. */
    cooldownAfterFailureMs: number;
}
```

### `HarmonizationCampaign`
```typescript
interface HarmonizationCampaign {
    readonly campaignId: HarmonizationCampaignId;
    readonly matchId: string;
    readonly ruleId: HarmonizationRuleId;
    readonly driftId: HarmonizationDriftId;
    readonly label: string;
    readonly scope: HarmonizationScope;
    readonly riskLevel: HarmonizationRiskLevel;
    readonly createdAt: string;  // ISO-8601
    readonly expiresAt: string;  // ISO-8601
    readonly bounds: HarmonizationCampaignBounds;

    // ── Mutable state ──────────────────────────────────────────────────────────
    status: HarmonizationCampaignStatus;
    updatedAt: string;
    currentFileIndex: number;
    haltReason?: string;
    governanceApprovedAt?: string;
    /** Set after post-campaign consistency re-scan. */
    consistencyVerifiedAt?: string;
    consistencyVerificationPassed?: boolean;
}
```

### `HarmonizationOutcomeRecord`
```typescript
interface HarmonizationOutcomeRecord {
    readonly outcomeId: HarmonizationOutcomeId;
    readonly campaignId: HarmonizationCampaignId;
    readonly ruleId: HarmonizationRuleId;
    readonly driftId: HarmonizationDriftId;
    readonly subsystem: string;
    readonly patternClass: HarmonizationPatternClass;
    readonly startedAt: string;  // ISO-8601
    readonly endedAt: string;    // ISO-8601
    readonly finalStatus: HarmonizationCampaignStatus;
    readonly succeeded: boolean;
    readonly driftReducedConfirmed: boolean;
    readonly regressionDetected: boolean;
    readonly rollbackTriggered: boolean;
    readonly filesModified: number;
    readonly confidenceDeltaApplied: number;
    readonly learningNotes: readonly string[];
}
```

### `HarmonizationDashboardKpis`
```typescript
interface HarmonizationDashboardKpis {
    readonly totalDriftDetected: number;
    readonly totalMatched: number;
    readonly totalCampaignsLaunched: number;
    readonly totalSucceeded: number;
    readonly totalFailed: number;
    readonly totalRolledBack: number;
    readonly totalDeferred: number;
    readonly totalSkipped: number;
    readonly activeCampaigns: number;
    readonly avgConfidenceAcrossRules: number;
}
```

### `HarmonizationRuleConfidenceSummary`
```typescript
interface HarmonizationRuleConfidenceSummary {
    readonly ruleId: HarmonizationRuleId;
    readonly label: string;
    readonly patternClass: HarmonizationPatternClass;
    readonly confidenceCurrent: number;
    readonly status: HarmonizationRuleStatus;
    readonly successCount: number;
    readonly failureCount: number;
    readonly regressionCount: number;
}
```

### `HarmonizationDashboardState`
```typescript
interface HarmonizationDashboardState {
    readonly computedAt: string; // ISO-8601
    readonly kpis: HarmonizationDashboardKpis;
    readonly pendingDriftRecords: HarmonizationDriftRecord[];
    readonly activeCampaigns: HarmonizationCampaign[];
    readonly deferredCampaigns: HarmonizationCampaign[];
    readonly recentOutcomes: HarmonizationOutcomeRecord[];
    readonly canonRuleSummaries: HarmonizationRuleConfidenceSummary[];
}
```

### `HarmonizationRuleId`
```typescript
type HarmonizationRuleId =  string;
```

### `HarmonizationDriftId`
```typescript
type HarmonizationDriftId =  string;
```

### `HarmonizationCampaignId`
```typescript
type HarmonizationCampaignId =  string;
```

### `HarmonizationOutcomeId`
```typescript
type HarmonizationOutcomeId =  string;
```

### `HarmonizationPatternClass`
```typescript
type HarmonizationPatternClass = 
    | 'preload_exposure_pattern'    // preload bridge namespace/method naming inconsistency
    | 'dashboard_subscription_pattern' // dashboard polling vs push-subscription style drift
    | 'registry_persistence_pattern'   // registry storage path/shape convention drift
    | 'telemetry_event_naming_pattern' // telemetry event key naming convention drift
    | 'service_wiring_pattern';
```

### `HarmonizationRiskLevel`
```typescript
type HarmonizationRiskLevel = 
    | 'low'     // rename-only or additive;
```

### `HarmonizationRuleStatus`
```typescript
type HarmonizationRuleStatus =  'active' | 'disabled' | 'deprecated';
```

### `HarmonizationMatchStrength`
```typescript
type HarmonizationMatchStrength =  'no_match' | 'weak_match' | 'strong_match';
```

### `HarmonizationDetectionHintKind`
```typescript
type HarmonizationDetectionHintKind = 
    | 'regex_mismatch'      // file content should/should-not match a regex
    | 'ipc_naming_check'    // IPC channel strings should follow namespace:verb convention
    | 'presence_absence'    // required pattern must be present (or absent)
    | 'symbol_naming_check' // exported symbol names should follow a pattern
    | 'telemetry_key_check';
```

### `HarmonizationCampaignStatus`
```typescript
type HarmonizationCampaignStatus = 
    | 'draft'               // plan built, not yet started
    | 'active'              // running — ready for next step
    | 'step_in_progress'    // a step is executing
    | 'awaiting_governance' // waiting for governance approval (high-risk rules)
    | 'paused'              // halted pending human review
    | 'deferred'            // temporarily suspended;
```

