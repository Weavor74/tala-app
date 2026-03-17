/**
 * MaintenanceLoopService — Phase 4B: Self-Maintenance Foundation
 *
 * The bounded self-maintenance state manager and loop coordinator.
 * Orchestrates issue detection, policy evaluation, and (optionally) action execution
 * based on the current maintenance mode.
 *
 * Responsibilities:
 * - Gather current issues from MaintenanceIssueDetector.
 * - Evaluate policy via MaintenancePolicyEngine.
 * - Optionally execute safe actions via MaintenanceActionExecutor.
 * - Update TalaMaintenanceState (cooldowns, suppressions, recent decisions).
 * - Expose a diagnostics read model (MaintenanceDiagnosticsSummary).
 * - Emit structured telemetry for all decisions and executions.
 *
 * Invocation strategy (event-driven, not a polling loop):
 * - After runtime state changes (provider status change, MCP restart)
 * - After world model build
 * - After provider failure
 * - Manual maintenance check (IPC: diagnostics:runMaintenanceCheck)
 *
 * Design rules:
 * - Default mode is 'recommend_only' — conservative and safe.
 * - No constant background polling — bounded invocations only.
 * - Auto-execution only in 'safe_auto_recovery' mode and only for safe actions.
 * - Cooldown and suppression prevent action thrashing.
 * - Ring buffers prevent unbounded memory growth.
 */

import { telemetry } from '../TelemetryService';
import { maintenanceIssueDetector } from './MaintenanceIssueDetector';
import { maintenancePolicyEngine } from './MaintenancePolicyEngine';
import { MaintenanceActionExecutor } from './MaintenanceActionExecutor';
import type { RuntimeDiagnosticsSnapshot } from '../../../shared/runtimeDiagnosticsTypes';
import type { TalaWorldModel } from '../../../shared/worldModelTypes';
import type { RuntimeControlService } from '../RuntimeControlService';
import type { McpServerConfig } from '../../../shared/settings';
import type {
    TalaMaintenanceState,
    MaintenanceDiagnosticsSummary,
    MaintenanceCognitiveSummary,
    MaintenanceMode,
    MaintenanceSeverityLevel,
    MaintenanceDecision,
} from '../../../shared/maintenance/maintenanceTypes';

// ─── Ring buffer sizes ────────────────────────────────────────────────────────

const MAX_RECENT_DECISIONS = 20;
const MAX_RECENT_EXECUTIONS = 10;

// ─── Default state ────────────────────────────────────────────────────────────

function makeDefaultState(mode: MaintenanceMode = 'recommend_only'): TalaMaintenanceState {
    return {
        mode,
        lastCheckedAt: null,
        activeIssues: [],
        recentDecisions: [],
        recentExecutions: [],
        cooldowns: {},
        suppressedCategories: {},
    };
}

// ─── MaintenanceLoopService ───────────────────────────────────────────────────

export class MaintenanceLoopService {
    private _state: TalaMaintenanceState;
    private _executor: MaintenanceActionExecutor;

    constructor(
        runtimeControl: RuntimeControlService,
        getMcpConfigs: () => McpServerConfig[],
        initialMode: MaintenanceMode = 'recommend_only',
    ) {
        this._state = makeDefaultState(initialMode);
        this._executor = new MaintenanceActionExecutor(runtimeControl, getMcpConfigs);
    }

    // ─── Mode control ─────────────────────────────────────────────────────────

    public setMode(mode: MaintenanceMode): void {
        const prior = this._state.mode;
        if (prior === mode) return;
        this._state.mode = mode;

        telemetry.operational('maintenance', 'maintenance_mode_changed', {
            status: 'success',
            summary: `Maintenance mode changed from '${prior}' to '${mode}'.`,
            payload: { priorMode: prior, newMode: mode },
        });
    }

    public getMode(): MaintenanceMode {
        return this._state.mode;
    }

    // ─── Main evaluation cycle ────────────────────────────────────────────────

    /**
     * Run a bounded maintenance evaluation cycle.
     * Detects issues, evaluates policy, and optionally executes safe actions.
     *
     * This should be called at bounded invocation points, not in a tight loop.
     */
    public async runCycle(
        diagnostics: RuntimeDiagnosticsSnapshot,
        worldModel?: TalaWorldModel,
    ): Promise<MaintenanceDiagnosticsSummary> {
        const cycleStart = Date.now();

        // 1. Detect issues
        const detected = maintenanceIssueDetector.detect(diagnostics, worldModel);

        // Emit telemetry for newly detected issues
        const existingIds = new Set(this._state.activeIssues.map(i => i.id));
        for (const issue of detected) {
            if (!existingIds.has(issue.id)) {
                telemetry.operational('maintenance', 'maintenance_issue_detected', {
                    status: 'partial',
                    summary: `Maintenance issue detected: ${issue.category} (${issue.severity})`,
                    payload: {
                        issueId: issue.id,
                        category: issue.category,
                        severity: issue.severity,
                        confidence: issue.confidence,
                        affectedEntityId: issue.affectedEntityId,
                        subsystem: issue.sourceSubsystem,
                    },
                });
            }
        }

        // Detect cleared issues
        const detectedIds = new Set(detected.map(i => i.category + (i.affectedEntityId ?? '')));
        for (const prior of this._state.activeIssues) {
            const key = prior.category + (prior.affectedEntityId ?? '');
            if (!detectedIds.has(key)) {
                telemetry.operational('maintenance', 'maintenance_issue_cleared', {
                    status: 'success',
                    summary: `Maintenance issue cleared: ${prior.category}`,
                    payload: { issueId: prior.id, category: prior.category, severity: prior.severity },
                });
            }
        }

        // Update active issues
        this._state.activeIssues = detected;
        this._state.lastCheckedAt = new Date().toISOString();

        // 2. Evaluate policy
        const decisions = maintenancePolicyEngine.evaluate(detected, {
            cooldowns: this._state.cooldowns,
            suppressedCategories: this._state.suppressedCategories,
            mode: this._state.mode,
        });

        // Emit policy evaluation telemetry
        telemetry.operational('maintenance', 'maintenance_policy_evaluated', {
            status: 'success',
            summary: `Maintenance policy evaluated: ${decisions.length} decision(s) for ${detected.length} issue(s).`,
            payload: {
                issueCount: detected.length,
                decisionCount: decisions.length,
                mode: this._state.mode,
                durationMs: Date.now() - cycleStart,
                autoExecuteCount: decisions.filter(d => d.outcome === 'auto_execute').length,
                recommendCount: decisions.filter(d => d.outcome === 'recommend_action').length,
                approvalNeededCount: decisions.filter(d => d.outcome === 'request_user_approval').length,
            },
        });

        // 3. Append decisions to ring buffer
        this._state.recentDecisions = [
            ...decisions,
            ...this._state.recentDecisions,
        ].slice(0, MAX_RECENT_DECISIONS);

        // 4. Apply cooldowns from proposals
        for (const decision of decisions) {
            if (decision.proposal?.cooldownUntil) {
                const key = decision.proposal.targetEntityId ?? decision.issue.category;
                this._state.cooldowns[key] = decision.proposal.cooldownUntil;

                telemetry.operational('maintenance', 'maintenance_cooldown_applied', {
                    status: 'success',
                    summary: `Maintenance cooldown applied to '${key}' until ${decision.proposal.cooldownUntil}.`,
                    payload: { key, cooldownUntil: decision.proposal.cooldownUntil },
                });
            }

            // Emit recommendation telemetry
            if (decision.outcome === 'recommend_action' || decision.outcome === 'request_user_approval') {
                telemetry.operational('maintenance', 'maintenance_action_recommended', {
                    status: 'partial',
                    summary: `Maintenance action recommended: ${decision.proposal?.actionType ?? 'none'}`,
                    payload: {
                        issueId: decision.issue.id,
                        category: decision.issue.category,
                        outcome: decision.outcome,
                        actionType: decision.proposal?.actionType,
                        targetEntityId: decision.proposal?.targetEntityId,
                        autoSafe: decision.proposal?.autoSafe ?? false,
                    },
                });
            }
        }

        // 5. Execute auto-safe actions if mode allows
        if (this._state.mode === 'safe_auto_recovery') {
            await this._executeAutoActions(decisions);
        }

        // 6. Return diagnostics summary
        return this.getDiagnosticsSummary();
    }

    // ─── Auto-execution ───────────────────────────────────────────────────────

    private async _executeAutoActions(decisions: MaintenanceDecision[]): Promise<void> {
        const autoActions = decisions.filter(
            d => d.outcome === 'auto_execute' && d.proposal?.autoSafe === true,
        );

        for (const decision of autoActions) {
            const proposal = decision.proposal!;
            const result = await this._executor.execute(proposal);

            this._state.recentExecutions = [
                result,
                ...this._state.recentExecutions,
            ].slice(0, MAX_RECENT_EXECUTIONS);

            // Update cooldown after execution
            if (result.cooldownUntil && proposal.targetEntityId) {
                this._state.cooldowns[proposal.targetEntityId] = result.cooldownUntil;
            } else if (result.cooldownUntil) {
                this._state.cooldowns[decision.issue.category] = result.cooldownUntil;
            }

            if (result.status === 'skipped') {
                telemetry.operational('maintenance', 'maintenance_action_skipped', {
                    status: 'suppressed',
                    summary: result.message,
                    payload: { actionType: proposal.actionType, issueId: proposal.issueId },
                });
            }
        }
    }

    // ─── Diagnostics read model ───────────────────────────────────────────────

    /**
     * Returns a safe, IPC-serializable diagnostics summary.
     */
    public getDiagnosticsSummary(): MaintenanceDiagnosticsSummary {
        const { activeIssues, recentDecisions, recentExecutions, cooldowns, mode, lastCheckedAt } = this._state;

        const issueCounts: Record<MaintenanceSeverityLevel, number> = {
            critical: 0, high: 0, medium: 0, low: 0, info: 0,
        };
        for (const issue of activeIssues) {
            issueCounts[issue.severity] = (issueCounts[issue.severity] ?? 0) + 1;
        }

        const now = new Date();
        const cooldownEntities = Object.entries(cooldowns)
            .filter(([, until]) => new Date(until) > now)
            .map(([key]) => key);

        const hasPendingAutoAction = recentDecisions.some(
            d => d.outcome === 'auto_execute' && d.proposal?.autoSafe,
        );
        const hasApprovalNeededAction = recentDecisions.some(
            d => d.outcome === 'request_user_approval',
        );

        return {
            lastCheckedAt,
            mode,
            activeIssues,
            recentDecisions,
            recentExecutions,
            hasPendingAutoAction,
            hasApprovalNeededAction,
            issueCounts,
            cooldownEntities,
        };
    }

    /**
     * Returns a compact maintenance summary for the cognitive/pre-inference path.
     * Suppresses detail for irrelevant turns; only exposes when maintenance context matters.
     */
    public getCognitiveSummary(): MaintenanceCognitiveSummary {
        const { activeIssues, recentDecisions, recentExecutions } = this._state;

        if (activeIssues.length === 0) {
            return {
                highestSeverity: null,
                activeIssueCount: 0,
                topIssueDescription: null,
                recentAutoRecovery: false,
                pendingApproval: false,
                recommendedAction: null,
            };
        }

        const severityOrder: Record<MaintenanceSeverityLevel, number> = {
            critical: 0, high: 1, medium: 2, low: 3, info: 4,
        };
        const sorted = [...activeIssues].sort(
            (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
        );
        const top = sorted[0];

        const recentAutoRecovery = recentExecutions.some(r => r.status === 'success');
        const pendingApproval = recentDecisions.some(d => d.outcome === 'request_user_approval');

        const recommendDecision = recentDecisions.find(
            d => d.outcome === 'recommend_action' && d.proposal,
        );
        const recommendedAction = recommendDecision?.proposal
            ? `Recommended: ${recommendDecision.proposal.actionType} for '${recommendDecision.proposal.targetEntityId ?? recommendDecision.issue.category}'`
            : null;

        return {
            highestSeverity: top.severity,
            activeIssueCount: activeIssues.length,
            topIssueDescription: top.description,
            recentAutoRecovery,
            pendingApproval,
            recommendedAction,
        };
    }

    /**
     * Returns whether there are any active critical or high-severity issues.
     * Used by PreInferenceContextOrchestrator to decide whether to include maintenance context.
     */
    public hasActionableIssues(): boolean {
        return this._state.activeIssues.some(
            i => i.severity === 'critical' || i.severity === 'high',
        );
    }

    // ─── State accessors ──────────────────────────────────────────────────────

    public getState(): Readonly<TalaMaintenanceState> {
        return this._state;
    }

    public getLastCheckedAt(): string | null {
        return this._state.lastCheckedAt;
    }
}
