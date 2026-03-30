/**
 * harmonizationTypes.ts — Phase 5.6 Canonical Harmonization Contracts
 *
 * P5.6A: Harmonization Types & Contracts
 *
 * Canonical shared contracts for the Code Harmonization Campaign Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Local-first: no network, no cloud state
 * - Deterministic-first: all drift detection and rule matching is rule-based
 * - Bounded: campaigns have hard caps on files, pattern classes, and age
 * - Auditable: every harmonization decision is recorded with timestamp and reason
 * - Non-bypassing: all harmonization steps still flow through planning, governance, execution
 * - No recursion: harmonization campaigns may not spawn child campaigns
 * - One active harmonization campaign per subsystem
 * - Rule-driven: harmonization only against committed canon rules
 *
 * Relationship to prior phases:
 *   Phase 5.5 (campaigns)        — HarmonizationCampaign maps onto RepairCampaign structure
 *   Phase 2   (planning)         — SafeChangePlanner invoked per step
 *   Phase 3.5 (governance)       — every step requires governance approval
 *   Phase 3   (execution)        — every step requires execution eligibility
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable identifier for a harmonization canon rule. Prefixed `canon-`. */
export type HarmonizationRuleId = string;

/** Stable identifier for a drift detection record. Prefixed `drift-`. */
export type HarmonizationDriftId = string;

/** Stable identifier for a harmonization campaign. Prefixed `hcampaign-`. */
export type HarmonizationCampaignId = string;

/** Stable identifier for a harmonization outcome record. Prefixed `houtcome-`. */
export type HarmonizationOutcomeId = string;

// ─── Pattern Classification ────────────────────────────────────────────────────

/**
 * The structural class of pattern drift a canon rule governs.
 * Determines which scanner sub-checks the DriftDetector activates.
 */
export type HarmonizationPatternClass =
    | 'preload_exposure_pattern'    // preload bridge namespace/method naming inconsistency
    | 'dashboard_subscription_pattern' // dashboard polling vs push-subscription style drift
    | 'registry_persistence_pattern'   // registry storage path/shape convention drift
    | 'telemetry_event_naming_pattern' // telemetry event key naming convention drift
    | 'service_wiring_pattern';        // service registration / IPC namespace naming drift

// ─── Risk Classification ──────────────────────────────────────────────────────

/**
 * Risk level assigned to a canon rule.
 * Drives governance tier required before campaign execution.
 */
export type HarmonizationRiskLevel =
    | 'low'     // rename-only or additive; rollback trivial
    | 'medium'  // modifies shared interface or IPC contract; rollback possible
    | 'high';   // modifies multiple subsystem boundaries; human review required

// ─── Rule Status ──────────────────────────────────────────────────────────────

/** Whether the canon rule is available for matching. */
export type HarmonizationRuleStatus = 'active' | 'disabled' | 'deprecated';

// ─── Match Strength ───────────────────────────────────────────────────────────

/**
 * Strength of a drift-to-rule match produced by HarmonizationMatcher.
 *
 * no_match    — no canon rule covers this drift
 * weak_match  — rule applies but confidence or evidence is borderline; defer recommended
 * strong_match — rule applies with sufficient evidence and confidence; campaign can proceed
 */
export type HarmonizationMatchStrength = 'no_match' | 'weak_match' | 'strong_match';

// ─── Detection Hint Kind ──────────────────────────────────────────────────────

/**
 * The kind of structural check a detection hint performs.
 * Used by HarmonizationDriftDetector to run the correct sub-check.
 */
export type HarmonizationDetectionHintKind =
    | 'regex_mismatch'      // file content should/should-not match a regex
    | 'ipc_naming_check'    // IPC channel strings should follow namespace:verb convention
    | 'presence_absence'    // required pattern must be present (or absent)
    | 'symbol_naming_check' // exported symbol names should follow a pattern
    | 'telemetry_key_check'; // telemetry.operational() call keys should follow schema

// ─── Detection Hint ───────────────────────────────────────────────────────────

/**
 * One deterministic structural indicator used by the drift detector.
 *
 * pattern     — the check argument (regex string, prefix string, or inclusion string)
 * expectMatch — true: compliant file MUST match; false: compliant file must NOT match
 * weight      — 0–1; contribution to computed drift severity
 */
export interface HarmonizationDetectionHint {
    readonly hintKind: HarmonizationDetectionHintKind;
    readonly label: string;
    readonly pattern: string;
    readonly expectMatch: boolean;
    readonly weight: number;
}

// ─── Canon Rule ───────────────────────────────────────────────────────────────

/**
 * A committed canon rule defining one harmonization pattern.
 *
 * Static definition fields are committed in source (defaults/harmonizationCanon.ts).
 * Runtime fields (confidenceCurrent, status, counts) are persisted separately
 * in <dataDir>/autonomy/harmonization/canon_registry.json.
 */
export interface HarmonizationCanonRule {
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

// ─── Drift Record ─────────────────────────────────────────────────────────────

/**
 * A detected instance of pattern drift produced by HarmonizationDriftDetector.
 * Immutable after creation.
 */
export interface HarmonizationDriftRecord {
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

/**
 * Result of evaluating one detection hint against one file.
 */
export interface HarmonizationHintResult {
    readonly hintLabel: string;
    readonly filePath: string;
    readonly passed: boolean;
    readonly detail?: string;
}

// ─── Match ────────────────────────────────────────────────────────────────────

/**
 * Result of HarmonizationMatcher.match() — maps a drift record to a rule.
 */
export interface HarmonizationMatch {
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

// ─── Scope ────────────────────────────────────────────────────────────────────

/**
 * The bounded scope of one harmonization campaign.
 *
 * Safety invariants:
 *   targetFiles.length <= DEFAULT_HARMONIZATION_BOUNDS.maxFiles
 *   patternClasses.length === 1 (one pattern class per campaign)
 *   targetSubsystem is a single string (no cross-subsystem campaigns)
 */
export interface HarmonizationScope {
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

// ─── Campaign Input ───────────────────────────────────────────────────────────

/**
 * Input to HarmonizationCampaignPlanner.
 * Built from a confirmed HarmonizationMatch.
 */
export interface HarmonizationCampaignInput {
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

// ─── Proposal Metadata ────────────────────────────────────────────────────────

/**
 * Metadata attached to a ChangeProposal produced during a harmonization step.
 * Allows planning, governance, and audit layers to reason about context.
 */
export interface HarmonizationProposalMetadata {
    readonly campaignId: HarmonizationCampaignId;
    readonly ruleId: HarmonizationRuleId;
    readonly patternClass: HarmonizationPatternClass;
    readonly driftSeverity: number;
    readonly intendedConvergence: string;
    readonly targetFile: string;
    readonly riskLevel: HarmonizationRiskLevel;
}

// ─── Campaign Status ──────────────────────────────────────────────────────────

/**
 * Lifecycle status of a harmonization campaign.
 */
export type HarmonizationCampaignStatus =
    | 'draft'               // plan built, not yet started
    | 'active'              // running — ready for next step
    | 'step_in_progress'    // a step is executing
    | 'awaiting_governance' // waiting for governance approval (high-risk rules)
    | 'paused'              // halted pending human review
    | 'deferred'            // temporarily suspended; may be resumed
    | 'succeeded'           // all steps completed successfully
    | 'failed'              // aborted due to step failure
    | 'rolled_back'         // terminated after rollback
    | 'aborted'             // aborted by operator or safety guard
    | 'skipped'             // fallback: low confidence / ambiguous drift
    | 'expired';            // exceeded maxAgeMs

// ─── Campaign Bounds ──────────────────────────────────────────────────────────

/**
 * Hard limits enforced by the harmonization layer.
 * These are separate from Phase 5.5 CampaignBounds to keep the concerns isolated.
 */
export interface HarmonizationCampaignBounds {
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

/**
 * Conservative default bounds for harmonization campaigns.
 */
export const DEFAULT_HARMONIZATION_BOUNDS: HarmonizationCampaignBounds = {
    maxFiles: 8,
    maxPatternClasses: 1,
    maxSteps: 6,
    maxAgeMs: 6 * 60 * 60 * 1000,          // 6 hours
    stepTimeoutMs: 15 * 60 * 1000,          // 15 minutes per step
    cooldownAfterFailureMs: 45 * 60 * 1000, // 45 minutes
};

/**
 * Minimum confidence margin above confidenceFloor required before matching.
 * Rules below this margin are skipped with reason 'low_confidence'.
 */
export const HARMONIZATION_MIN_CONFIDENCE_MARGIN = 0.10;

// ─── Harmonization Campaign ───────────────────────────────────────────────────

/**
 * One bounded harmonization campaign.
 *
 * Safety invariants:
 *   - One active harmonization campaign per subsystem
 *   - Steps execute one at a time through planning → governance → execution
 *   - No harmonization campaign may spawn child campaigns
 *   - Scope is immutable after creation
 *   - Protected subsystems cannot be targeted
 */
export interface HarmonizationCampaign {
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

// ─── Outcome Record ───────────────────────────────────────────────────────────

/**
 * Immutable record written by HarmonizationOutcomeTracker when a campaign
 * reaches a terminal state.
 */
export interface HarmonizationOutcomeRecord {
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

// ─── Dashboard State ──────────────────────────────────────────────────────────

/**
 * KPI summary for the harmonization dashboard.
 */
export interface HarmonizationDashboardKpis {
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

/**
 * Per-rule confidence summary shown in the dashboard.
 */
export interface HarmonizationRuleConfidenceSummary {
    readonly ruleId: HarmonizationRuleId;
    readonly label: string;
    readonly patternClass: HarmonizationPatternClass;
    readonly confidenceCurrent: number;
    readonly status: HarmonizationRuleStatus;
    readonly successCount: number;
    readonly failureCount: number;
    readonly regressionCount: number;
}

/**
 * Full harmonization dashboard state emitted on `harmonization:dashboardUpdate`.
 */
export interface HarmonizationDashboardState {
    readonly computedAt: string; // ISO-8601
    readonly kpis: HarmonizationDashboardKpis;
    readonly pendingDriftRecords: HarmonizationDriftRecord[];
    readonly activeCampaigns: HarmonizationCampaign[];
    readonly deferredCampaigns: HarmonizationCampaign[];
    readonly recentOutcomes: HarmonizationOutcomeRecord[];
    readonly canonRuleSummaries: HarmonizationRuleConfidenceSummary[];
}
