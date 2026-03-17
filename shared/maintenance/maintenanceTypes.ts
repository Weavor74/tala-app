/**
 * Canonical Self-Maintenance Types — Phase 4B: Self-Maintenance Foundation
 *
 * Defines the single authoritative type model for Tala's self-maintenance layer.
 * This covers:
 *   - maintenance issue detection and classification
 *   - policy evaluation and decision outcomes
 *   - action proposals and execution results
 *   - bounded safety model (auto-safe vs approval-needed)
 *   - maintenance state / diagnostics read model
 *
 * Design rules:
 * - All types are bounded and typed — no giant freeform strings as the main representation.
 * - Safety constraints are first-class: destructive actions are never auto-executable.
 * - Confidence is always explicit so the system can preserve unknown/degraded state.
 * - Cooldown and suppression are structural, not ad hoc.
 * - Snapshot is safe to serialize over IPC (no circular refs, no functions).
 */

// ─── Maintenance issue categories ────────────────────────────────────────────

/**
 * Canonical categories for detected maintenance issues.
 * Each category corresponds to a bounded detection rule and at most one policy path.
 */
export type MaintenanceIssueCategory =
    | 'provider_unavailable'
    | 'provider_degraded'
    | 'mcp_service_unavailable'
    | 'mcp_service_flapping'
    | 'setup_environment_issue'
    | 'missing_dependency'
    | 'memory_health_issue'
    | 'workspace_state_issue'
    | 'repo_state_issue'
    | 'unknown_runtime_instability';

// ─── Maintenance severity ─────────────────────────────────────────────────────

/**
 * Severity classification for a detected maintenance issue.
 * critical — requires immediate attention; may block core operations.
 * high     — significantly impacts operations; should be resolved soon.
 * medium   — partial degradation; monitoring or recommendation appropriate.
 * low      — minor issue; informational or deferred action.
 * info     — observation only; no action required.
 */
export type MaintenanceSeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

// ─── Maintenance action types ─────────────────────────────────────────────────

/**
 * Canonical action types for maintenance proposals.
 * Each type maps to one or more bounded execution paths in MaintenanceActionExecutor.
 */
export type MaintenanceActionType =
    | 'reprobe_providers'           // Re-probe inference provider availability
    | 'restart_provider'            // Restart a degraded inference provider
    | 'reprobe_mcp_services'        // Re-probe MCP service availability
    | 'restart_mcp_service'         // Restart an unavailable/degraded MCP service
    | 'disable_provider_temporarily' // Suppress a flapping provider to reduce noise
    | 'escalate_to_user'            // Surface an issue that requires user action
    | 'monitor_only';               // No action; observe and re-evaluate later

// ─── Maintenance decision outcomes ────────────────────────────────────────────

/**
 * Policy engine decision outcome for a detected maintenance issue.
 * no_action            — issue is below threshold or already handled.
 * monitor              — track but do not act; re-evaluate on next cycle.
 * recommend_action     — surface a recommendation to the user/diagnostics.
 * request_user_approval — action identified but requires explicit user approval.
 * auto_execute         — action is safe, reversible, and may be executed immediately.
 * suppress_temporarily — same recommendation seen recently; suppress until cooldown clears.
 */
export type MaintenancePolicyOutcome =
    | 'no_action'
    | 'monitor'
    | 'recommend_action'
    | 'request_user_approval'
    | 'auto_execute'
    | 'suppress_temporarily';

// ─── Execution result status ──────────────────────────────────────────────────

/**
 * Result status for a maintenance action execution attempt.
 */
export type MaintenanceExecutionStatus =
    | 'success'
    | 'failed'
    | 'skipped'
    | 'blocked_by_policy'
    | 'requires_user_approval';

// ─── Maintenance mode ─────────────────────────────────────────────────────────

/**
 * Operational mode for the self-maintenance loop.
 * observation_only  — detect and record issues; no actions proposed or executed.
 * recommend_only    — detect issues and propose actions; never auto-execute.
 * safe_auto_recovery — detect, propose, and auto-execute only safe/reversible actions.
 */
export type MaintenanceMode =
    | 'observation_only'
    | 'recommend_only'
    | 'safe_auto_recovery';

// ─── Maintenance issue ────────────────────────────────────────────────────────

/**
 * A detected maintenance issue.
 * Represents a bounded, typed description of a runtime problem.
 */
export interface MaintenanceIssue {
    /** Unique issue ID for correlation and deduplication. */
    id: string;
    /** ISO 8601 timestamp when this issue was detected. */
    detectedAt: string;
    /** Category of the issue. */
    category: MaintenanceIssueCategory;
    /** Severity classification. */
    severity: MaintenanceSeverityLevel;
    /**
     * Confidence in this detection (0–1).
     * Low confidence issues are downgraded and logged but not acted upon.
     */
    confidence: number;
    /** Subsystem that surfaced this issue. */
    sourceSubsystem: string;
    /** Entity ID (providerId, serviceId, etc.) affected, if applicable. */
    affectedEntityId?: string;
    /** Human-readable description of the issue (no sensitive data). */
    description: string;
    /** Whether this issue is safe to auto-execute a recovery action for. */
    safeToAutoExecute: boolean;
    /** Whether user approval is required to act on this issue. */
    requiresApproval: boolean;
}

// ─── Maintenance action proposal ──────────────────────────────────────────────

/**
 * A proposed maintenance action.
 * Issued by the policy engine; executed by the action executor if approved.
 */
export interface MaintenanceActionProposal {
    /** Unique proposal ID. */
    id: string;
    /** Issue ID this proposal addresses. */
    issueId: string;
    /** The proposed action type. */
    actionType: MaintenanceActionType;
    /** Target entity ID (providerId, serviceId, etc.), if applicable. */
    targetEntityId?: string;
    /** ISO 8601 timestamp when this proposal was created. */
    proposedAt: string;
    /** Policy outcome that led to this proposal. */
    policyOutcome: MaintenancePolicyOutcome;
    /** Whether this action is safe to auto-execute (confirmed by policy). */
    autoSafe: boolean;
    /** Human-readable reason for this action proposal. */
    rationale: string;
    /** Cooldown end time — if set, this action should not be re-proposed before this time. */
    cooldownUntil?: string;
}

// ─── Maintenance decision ─────────────────────────────────────────────────────

/**
 * The full policy decision record for a single issue.
 * Links the issue, the policy outcome, and any generated action proposal.
 */
export interface MaintenanceDecision {
    /** Issue that was evaluated. */
    issue: MaintenanceIssue;
    /** Policy outcome. */
    outcome: MaintenancePolicyOutcome;
    /** Action proposal, if any. */
    proposal?: MaintenanceActionProposal;
    /** ISO 8601 timestamp of this decision. */
    decidedAt: string;
    /** Human-readable reason for the policy outcome. */
    rationale: string;
}

// ─── Maintenance execution result ─────────────────────────────────────────────

/**
 * Result of a maintenance action execution attempt.
 */
export interface MaintenanceExecutionResult {
    /** Proposal that was executed (or attempted). */
    proposal: MaintenanceActionProposal;
    /** Execution status. */
    status: MaintenanceExecutionStatus;
    /** ISO 8601 timestamp of execution completion. */
    executedAt: string;
    /** Human-readable execution outcome (no sensitive data). */
    message: string;
    /** Error detail if execution failed (no sensitive data). */
    error?: string;
    /** Cooldown ISO timestamp applied after this execution, if any. */
    cooldownUntil?: string;
}

// ─── Maintenance diagnostics summary ─────────────────────────────────────────

/**
 * IPC-safe diagnostics read model for the current maintenance state.
 * Read-only for the renderer; no policy evaluation is pushed to the UI.
 */
export interface MaintenanceDiagnosticsSummary {
    /** ISO 8601 timestamp of the last maintenance check. */
    lastCheckedAt: string | null;
    /** Current maintenance mode. */
    mode: MaintenanceMode;
    /** Active issues (detected but not yet cleared). */
    activeIssues: MaintenanceIssue[];
    /** Most recent policy decisions (ring buffer, bounded). */
    recentDecisions: MaintenanceDecision[];
    /** Most recent execution results (ring buffer, bounded). */
    recentExecutions: MaintenanceExecutionResult[];
    /** Whether any auto-execute-eligible action is pending. */
    hasPendingAutoAction: boolean;
    /** Whether any approval-needed action is waiting. */
    hasApprovalNeededAction: boolean;
    /** Count of active issues by severity. */
    issueCounts: Record<MaintenanceSeverityLevel, number>;
    /** IDs of entities currently under maintenance cooldown. */
    cooldownEntities: string[];
}

// ─── Tala maintenance state ───────────────────────────────────────────────────

/**
 * Top-level self-maintenance state carried by the maintenance service.
 * Internal to the backend; not exposed raw over IPC.
 */
export interface TalaMaintenanceState {
    /** Current operational mode. */
    mode: MaintenanceMode;
    /** ISO 8601 timestamp of the last maintenance evaluation cycle. */
    lastCheckedAt: string | null;
    /** Currently active issues. */
    activeIssues: MaintenanceIssue[];
    /** Recent decisions (ring buffer). */
    recentDecisions: MaintenanceDecision[];
    /** Recent execution results (ring buffer). */
    recentExecutions: MaintenanceExecutionResult[];
    /** Cooldown registry: entityId → cooldown expiry ISO timestamp. */
    cooldowns: Record<string, string>;
    /** Suppression registry: issueCategory → suppressed-until ISO timestamp. */
    suppressedCategories: Record<string, string>;
}

// ─── Maintenance cognitive summary ───────────────────────────────────────────

/**
 * Compact maintenance summary safe for injection into the cognitive/inference path.
 * Used by PreInferenceContextOrchestrator when the turn is maintenance-relevant.
 * Must be small — no raw issue lists or full execution logs.
 */
export interface MaintenanceCognitiveSummary {
    /** Highest severity of currently active issues. */
    highestSeverity: MaintenanceSeverityLevel | null;
    /** Number of active issues. */
    activeIssueCount: number;
    /** Short description of the most critical issue, if any. */
    topIssueDescription: string | null;
    /** Whether any auto-recovery was attempted in the last cycle. */
    recentAutoRecovery: boolean;
    /** Whether any issue is waiting for user approval. */
    pendingApproval: boolean;
    /** Recommended user-facing action, if any. */
    recommendedAction: string | null;
}
