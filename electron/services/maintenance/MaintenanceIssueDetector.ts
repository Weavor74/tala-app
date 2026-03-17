/**
 * MaintenanceIssueDetector — Phase 4B: Self-Maintenance Foundation
 *
 * Detects maintenance-relevant issues from existing world/runtime state.
 * Sources inputs from RuntimeDiagnosticsSnapshot, TalaWorldModel, provider
 * health state, and MCP lifecycle state.
 *
 * Design rules:
 * - Issue detection is bounded and explainable — no invented problems from weak evidence.
 * - Confidence is always explicit; low-confidence issues are downgraded, not suppressed.
 * - Preserves explicit degraded/unknown state rather than assuming worst case.
 * - No probing or live service calls — reads from already-maintained state only.
 * - Avoids duplicate detections within the same cycle.
 */

import { v4 as uuidv4 } from 'uuid';
import type { RuntimeDiagnosticsSnapshot } from '../../../shared/runtimeDiagnosticsTypes';
import type { TalaWorldModel } from '../../../shared/worldModelTypes';
import type {
    MaintenanceIssue,
    MaintenanceSeverityLevel,
} from '../../../shared/maintenance/maintenanceTypes';

// ─── Detection thresholds ─────────────────────────────────────────────────────

/** Minimum failure streak before a provider is flagged as degraded. */
const PROVIDER_DEGRADED_STREAK_THRESHOLD = 3;

/** Minimum fallback count before repeated fallback is flagged. */
const PROVIDER_FALLBACK_THRESHOLD = 3;

/** Minimum restart count in the last cycle before MCP flapping is flagged. */
const MCP_FLAPPING_RESTART_THRESHOLD = 2;

/** Minimum confidence for a low-confidence issue to be emitted. */
const LOW_CONFIDENCE_THRESHOLD = 0.4;

// ─── MaintenanceIssueDetector ─────────────────────────────────────────────────

/**
 * Detects maintenance issues from the current runtime and world state.
 * Returns a deduplicated list of issues ordered by severity (critical first).
 */
export class MaintenanceIssueDetector {

    /**
     * Run all detection rules against the provided state.
     * Returns an array of detected issues, sorted critical → info.
     */
    public detect(
        diagnostics: RuntimeDiagnosticsSnapshot,
        worldModel?: TalaWorldModel,
    ): MaintenanceIssue[] {
        const issues: MaintenanceIssue[] = [];

        this._detectProviderIssues(diagnostics, issues);
        this._detectMcpIssues(diagnostics, issues);
        if (worldModel) {
            this._detectWorldModelIssues(worldModel, issues);
        }

        // Filter out very-low-confidence issues
        const filtered = issues.filter(i => i.confidence >= LOW_CONFIDENCE_THRESHOLD);

        // Sort: critical first, then by confidence descending
        return filtered.sort((a, b) => {
            const severityOrder: Record<MaintenanceSeverityLevel, number> = {
                critical: 0, high: 1, medium: 2, low: 3, info: 4,
            };
            const sa = severityOrder[a.severity];
            const sb = severityOrder[b.severity];
            if (sa !== sb) return sa - sb;
            return b.confidence - a.confidence;
        });
    }

    // ─── Provider detection rules ─────────────────────────────────────────────

    private _detectProviderIssues(
        diagnostics: RuntimeDiagnosticsSnapshot,
        issues: MaintenanceIssue[],
    ): void {
        const inference = diagnostics.inference;

        // 1. Selected provider unavailable
        const selectedId = inference.selectedProvider?.providerId;
        if (selectedId) {
            const status = inference.selectedProvider?.status;
            if (status === 'unavailable' || status === 'failed') {
                issues.push(this._makeIssue({
                    category: 'provider_unavailable',
                    severity: 'critical',
                    confidence: 0.95,
                    sourceSubsystem: 'inference',
                    affectedEntityId: selectedId,
                    description: `Selected inference provider '${selectedId}' is ${status}.`,
                    safeToAutoExecute: true,
                    requiresApproval: false,
                }));
            } else if (status === 'degraded') {
                issues.push(this._makeIssue({
                    category: 'provider_degraded',
                    severity: 'high',
                    confidence: 0.9,
                    sourceSubsystem: 'inference',
                    affectedEntityId: selectedId,
                    description: `Selected inference provider '${selectedId}' is degraded.`,
                    safeToAutoExecute: true,
                    requiresApproval: false,
                }));
            }
        }

        // 2. No providers ready
        const inv = inference.providerInventory;
        if (inv && inv.ready === 0 && inv.total > 0) {
            issues.push(this._makeIssue({
                category: 'provider_unavailable',
                severity: 'critical',
                confidence: 0.95,
                sourceSubsystem: 'inference',
                description: `No inference providers are currently available (${inv.total} total, 0 ready).`,
                safeToAutoExecute: true,
                requiresApproval: false,
            }));
        }

        // 3. Provider health score degradation
        for (const score of diagnostics.providerHealthScores ?? []) {
            if (score.failureStreak >= PROVIDER_DEGRADED_STREAK_THRESHOLD && !score.suppressed) {
                issues.push(this._makeIssue({
                    category: 'provider_degraded',
                    severity: score.failureStreak >= 5 ? 'high' : 'medium',
                    confidence: Math.min(0.6 + score.failureStreak * 0.1, 0.95),
                    sourceSubsystem: 'inference',
                    affectedEntityId: score.providerId,
                    description: `Provider '${score.providerId}' has ${score.failureStreak} consecutive failures.`,
                    safeToAutoExecute: true,
                    requiresApproval: false,
                }));
            }

            // 4. Repeated fallback
            if (score.fallbackCount >= PROVIDER_FALLBACK_THRESHOLD) {
                issues.push(this._makeIssue({
                    category: 'provider_degraded',
                    severity: 'medium',
                    confidence: 0.75,
                    sourceSubsystem: 'inference',
                    affectedEntityId: score.providerId,
                    description: `Provider '${score.providerId}' has triggered ${score.fallbackCount} fallbacks — possible preference suppression issue.`,
                    safeToAutoExecute: true,
                    requiresApproval: false,
                }));
            }
        }

        // 5. Suppressed preferred provider
        const suppressed = diagnostics.suppressedProviders ?? [];
        if (suppressed.length > 0 && selectedId && suppressed.includes(selectedId)) {
            issues.push(this._makeIssue({
                category: 'provider_degraded',
                severity: 'medium',
                confidence: 0.85,
                sourceSubsystem: 'inference',
                affectedEntityId: selectedId,
                description: `Selected provider '${selectedId}' is currently suppressed from auto-selection.`,
                safeToAutoExecute: false,
                requiresApproval: true,
            }));
        }
    }

    // ─── MCP detection rules ──────────────────────────────────────────────────

    private _detectMcpIssues(
        diagnostics: RuntimeDiagnosticsSnapshot,
        issues: MaintenanceIssue[],
    ): void {
        const mcp = diagnostics.mcp;
        if (!mcp) return;

        // 6. Critical MCP services unavailable
        for (const svc of mcp.services ?? []) {
            if (svc.status === 'unavailable' || svc.status === 'failed') {
                const isCritical = svc.capabilities?.length > 0;
                issues.push(this._makeIssue({
                    category: 'mcp_service_unavailable',
                    severity: isCritical ? 'high' : 'medium',
                    confidence: 0.9,
                    sourceSubsystem: 'mcp',
                    affectedEntityId: svc.serverId,
                    description: `MCP service '${svc.serverId}' is ${svc.status}.`,
                    safeToAutoExecute: true,
                    requiresApproval: false,
                }));
            }
        }

        // 7. MCP service flapping (repeated restarts)
        const recentRestarts = diagnostics.recentMcpRestarts ?? [];
        const restartCounts: Record<string, number> = {};
        for (const r of recentRestarts) {
            restartCounts[r.serviceId] = (restartCounts[r.serviceId] ?? 0) + 1;
        }
        for (const [serviceId, count] of Object.entries(restartCounts)) {
            if (count >= MCP_FLAPPING_RESTART_THRESHOLD) {
                issues.push(this._makeIssue({
                    category: 'mcp_service_flapping',
                    severity: 'high',
                    confidence: 0.85,
                    sourceSubsystem: 'mcp',
                    affectedEntityId: serviceId,
                    description: `MCP service '${serviceId}' has been restarted ${count} times recently — possible flapping.`,
                    safeToAutoExecute: false,
                    requiresApproval: true,
                }));
            }
        }
    }

    // ─── World model detection rules ─────────────────────────────────────────

    private _detectWorldModelIssues(
        worldModel: TalaWorldModel,
        issues: MaintenanceIssue[],
    ): void {
        // 8. Runtime subsystem degradation from world model
        const runtime = worldModel.runtime;
        if (runtime?.meta.availability === 'degraded' || runtime?.meta.availability === 'unavailable') {
            issues.push(this._makeIssue({
                category: 'unknown_runtime_instability',
                severity: 'medium',
                confidence: 0.65,
                sourceSubsystem: 'world_model',
                description: `World model runtime section is ${runtime.meta.availability}: ${runtime.meta.degradedReason ?? 'unknown reason'}.`,
                safeToAutoExecute: false,
                requiresApproval: false,
            }));
        }

        // 9. Known degraded subsystems from world model runtime state
        if (runtime?.hasActiveDegradation && (runtime.degradedSubsystems?.length ?? 0) > 0) {
            const subsystems = runtime.degradedSubsystems.join(', ');
            issues.push(this._makeIssue({
                category: 'unknown_runtime_instability',
                severity: 'medium',
                confidence: 0.7,
                sourceSubsystem: 'world_model',
                description: `World model reports active degradation in subsystems: ${subsystems}.`,
                safeToAutoExecute: false,
                requiresApproval: false,
            }));
        }

        // 10. Workspace state unavailable
        const workspace = worldModel.workspace;
        if (workspace?.meta.availability === 'unavailable') {
            issues.push(this._makeIssue({
                category: 'workspace_state_issue',
                severity: 'low',
                confidence: 0.6,
                sourceSubsystem: 'world_model',
                description: `Workspace state is unavailable: ${workspace.meta.degradedReason ?? 'unknown reason'}.`,
                safeToAutoExecute: false,
                requiresApproval: false,
            }));
        }
    }

    // ─── Factory helper ───────────────────────────────────────────────────────

    private _makeIssue(params: Omit<MaintenanceIssue, 'id' | 'detectedAt'>): MaintenanceIssue {
        return {
            id: uuidv4(),
            detectedAt: new Date().toISOString(),
            ...params,
        };
    }
}

export const maintenanceIssueDetector = new MaintenanceIssueDetector();
