/**
 * MaintenancePolicyEngine — Phase 4B: Self-Maintenance Foundation
 *
 * Single canonical policy engine that decides what Tala should do about each
 * detected maintenance issue.
 *
 * For each issue, classifies the outcome into one of:
 *   no_action | monitor | recommend_action | request_user_approval | auto_execute | suppress_temporarily
 *
 * Policy rules enforce:
 * - Auto-execution only for safe, reversible actions.
 * - Destructive or memory-touching actions are never auto-executed.
 * - Cooldown after repeated actions to prevent flapping.
 * - Suppression to avoid re-recommending the same issue every cycle.
 * - Approval required for restart loops, active-work interruptions, and user-data actions.
 *
 * Design rules:
 * - One canonical policy engine — no scattered per-service policy logic.
 * - All decisions are typed and logged.
 * - Cooldown registry is owned by the caller (TalaMaintenanceState.cooldowns).
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    MaintenanceIssue,
    MaintenanceActionProposal,
    MaintenanceDecision,
    MaintenancePolicyOutcome,
    MaintenanceActionType,
    MaintenanceMode,
} from '../../../shared/maintenance/maintenanceTypes';
// ─── Cooldown durations ───────────────────────────────────────────────────────

/** After a safe auto-executed action, prevent re-execution for this duration (ms). */
const AUTO_ACTION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** After a recommended action is surfaced, suppress re-recommending for this duration (ms). */
const RECOMMENDATION_SUPPRESSION_MS = 10 * 60 * 1000; // 10 minutes

/** After a flapping-detected restart, apply a longer cooldown. */
const FLAPPING_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ─── Policy state (passed in from TalaMaintenanceState) ──────────────────────

export interface PolicyContext {
    /** Cooldowns: entityId or issueCategory → ISO expiry timestamp. */
    cooldowns: Record<string, string>;
    /** Suppressed issue categories: category → ISO suppression expiry. */
    suppressedCategories: Record<string, string>;
    /** Current maintenance mode. */
    mode: MaintenanceMode;
}

// ─── MaintenancePolicyEngine ──────────────────────────────────────────────────

/**
 * Evaluates a set of maintenance issues against explicit policy rules.
 * Returns a set of typed decisions. Does not modify any state directly.
 */
export class MaintenancePolicyEngine {

    /**
     * Evaluate all detected issues and return policy decisions.
     * The PolicyContext (cooldowns, suppressions, mode) is read-only here;
     * the caller updates TalaMaintenanceState based on the returned decisions.
     */
    public evaluate(
        issues: MaintenanceIssue[],
        ctx: PolicyContext,
    ): MaintenanceDecision[] {
        return issues.map(issue => this._evaluateOne(issue, ctx));
    }

    // ─── Per-issue evaluation ─────────────────────────────────────────────────

    private _evaluateOne(issue: MaintenanceIssue, ctx: PolicyContext): MaintenanceDecision {
        const now = new Date();
        const decidedAt = now.toISOString();

        // 1. Check category-level suppression
        const categorySuppressedUntil = ctx.suppressedCategories[issue.category];
        if (categorySuppressedUntil && new Date(categorySuppressedUntil) > now) {
            return this._makeDecision(issue, 'suppress_temporarily', decidedAt,
                `Category '${issue.category}' is suppressed until ${categorySuppressedUntil}.`);
        }

        // 2. Observation-only mode: never act, just record
        if (ctx.mode === 'observation_only') {
            return this._makeDecision(issue, 'monitor', decidedAt,
                'Maintenance mode is observation_only — no action taken.');
        }

        // 3. Low-confidence issues: always monitor only
        if (issue.confidence < 0.5) {
            return this._makeDecision(issue, 'monitor', decidedAt,
                `Confidence ${issue.confidence.toFixed(2)} is below action threshold.`);
        }

        // 4. Apply issue-category specific policy rules
        return this._applyPolicyRule(issue, ctx, decidedAt, now);
    }

    private _applyPolicyRule(
        issue: MaintenanceIssue,
        ctx: PolicyContext,
        decidedAt: string,
        now: Date,
    ): MaintenanceDecision {
        switch (issue.category) {

            // ─── Provider unavailable ─────────────────────────────────────────
            case 'provider_unavailable': {
                const cooldownKey = issue.affectedEntityId ?? issue.category;
                if (this._isCooledDown(cooldownKey, ctx.cooldowns, now)) {
                    return this._makeDecision(issue, 'suppress_temporarily', decidedAt,
                        `Entity '${cooldownKey}' is under cooldown.`);
                }
                const actionType: MaintenanceActionType = issue.affectedEntityId
                    ? 'restart_provider' : 'reprobe_providers';
                if (ctx.mode === 'safe_auto_recovery' && issue.safeToAutoExecute) {
                    return this._makeDecisionWithAction(issue, 'auto_execute', decidedAt,
                        `Provider is unavailable — safe to auto re-probe/restart.`,
                        actionType, issue.affectedEntityId,
                        AUTO_ACTION_COOLDOWN_MS);
                }
                return this._makeDecisionWithAction(issue, 'recommend_action', decidedAt,
                    `Provider '${issue.affectedEntityId ?? 'unknown'}' is unavailable — recommend reprobe.`,
                    actionType, issue.affectedEntityId,
                    RECOMMENDATION_SUPPRESSION_MS);
            }

            // ─── Provider degraded ────────────────────────────────────────────
            case 'provider_degraded': {
                const cooldownKey = issue.affectedEntityId ?? issue.category;
                if (this._isCooledDown(cooldownKey, ctx.cooldowns, now)) {
                    return this._makeDecision(issue, 'suppress_temporarily', decidedAt,
                        `Entity '${cooldownKey}' is under cooldown.`);
                }
                if (issue.requiresApproval) {
                    return this._makeDecisionWithAction(issue, 'request_user_approval', decidedAt,
                        `Provider degradation requires user approval to resolve.`,
                        'escalate_to_user', issue.affectedEntityId);
                }
                if (ctx.mode === 'safe_auto_recovery' && issue.safeToAutoExecute) {
                    return this._makeDecisionWithAction(issue, 'auto_execute', decidedAt,
                        `Provider degraded — safe to auto-restart.`,
                        'restart_provider', issue.affectedEntityId,
                        AUTO_ACTION_COOLDOWN_MS);
                }
                return this._makeDecisionWithAction(issue, 'recommend_action', decidedAt,
                    `Provider '${issue.affectedEntityId ?? 'unknown'}' is degraded — recommend restart.`,
                    'restart_provider', issue.affectedEntityId,
                    RECOMMENDATION_SUPPRESSION_MS);
            }

            // ─── MCP service unavailable ──────────────────────────────────────
            case 'mcp_service_unavailable': {
                const cooldownKey = issue.affectedEntityId ?? issue.category;
                if (this._isCooledDown(cooldownKey, ctx.cooldowns, now)) {
                    return this._makeDecision(issue, 'suppress_temporarily', decidedAt,
                        `Entity '${cooldownKey}' is under cooldown.`);
                }
                if (ctx.mode === 'safe_auto_recovery' && issue.safeToAutoExecute) {
                    return this._makeDecisionWithAction(issue, 'auto_execute', decidedAt,
                        `MCP service unavailable — safe to auto-restart.`,
                        'restart_mcp_service', issue.affectedEntityId,
                        AUTO_ACTION_COOLDOWN_MS);
                }
                return this._makeDecisionWithAction(issue, 'recommend_action', decidedAt,
                    `MCP service '${issue.affectedEntityId ?? 'unknown'}' is unavailable — recommend restart.`,
                    'restart_mcp_service', issue.affectedEntityId,
                    RECOMMENDATION_SUPPRESSION_MS);
            }

            // ─── MCP service flapping ─────────────────────────────────────────
            case 'mcp_service_flapping': {
                // Flapping always requires approval — do not auto-restart a flapping service
                return this._makeDecisionWithAction(issue, 'request_user_approval', decidedAt,
                    `MCP service '${issue.affectedEntityId ?? 'unknown'}' is flapping — restart requires user approval.`,
                    'escalate_to_user', issue.affectedEntityId,
                    FLAPPING_COOLDOWN_MS);
            }

            // ─── Memory, workspace, repo issues ──────────────────────────────
            case 'memory_health_issue':
            case 'workspace_state_issue':
            case 'repo_state_issue': {
                // Memory and workspace issues never auto-execute — too risky
                return this._makeDecisionWithAction(issue, 'request_user_approval', decidedAt,
                    `Issue category '${issue.category}' requires user review before action.`,
                    'escalate_to_user', issue.affectedEntityId);
            }

            // ─── Setup / environment / dependency / instability ───────────────
            case 'setup_environment_issue':
            case 'missing_dependency':
            case 'unknown_runtime_instability': {
                if (issue.severity === 'info' || issue.severity === 'low') {
                    return this._makeDecision(issue, 'monitor', decidedAt,
                        `Low-severity ${issue.category} — monitoring only.`);
                }
                return this._makeDecision(issue, 'recommend_action', decidedAt,
                    `${issue.category} detected — user should investigate.`);
            }

            default:
                return this._makeDecision(issue, 'monitor', decidedAt,
                    `Unclassified issue category '${issue.category}' — monitoring only.`);
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private _isCooledDown(key: string, cooldowns: Record<string, string>, now: Date): boolean {
        const until = cooldowns[key];
        if (!until) return false;
        return new Date(until) > now;
    }

    private _makeDecision(
        issue: MaintenanceIssue,
        outcome: MaintenancePolicyOutcome,
        decidedAt: string,
        rationale: string,
    ): MaintenanceDecision {
        return { issue, outcome, decidedAt, rationale };
    }

    private _makeDecisionWithAction(
        issue: MaintenanceIssue,
        outcome: MaintenancePolicyOutcome,
        decidedAt: string,
        rationale: string,
        actionType: MaintenanceActionType,
        targetEntityId?: string,
        cooldownMs?: number,
    ): MaintenanceDecision {
        const proposedAt = decidedAt;
        const cooldownUntil = cooldownMs
            ? new Date(Date.now() + cooldownMs).toISOString()
            : undefined;

        const proposal: MaintenanceActionProposal = {
            id: uuidv4(),
            issueId: issue.id,
            actionType,
            targetEntityId,
            proposedAt,
            policyOutcome: outcome,
            autoSafe: outcome === 'auto_execute',
            rationale,
            cooldownUntil,
        };

        return { issue, outcome, proposal, decidedAt, rationale };
    }
}

export const maintenancePolicyEngine = new MaintenancePolicyEngine();
