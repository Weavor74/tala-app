/**
 * RuntimeWorldStateProjector — Phase 4A: World Model Foundation
 *
 * Projects RuntimeDiagnosticsSnapshot into the cognition-friendly
 * RuntimeWorldState, ToolWorldState, and ProviderWorldState types.
 *
 * This is NOT a duplicate of RuntimeDiagnosticsSnapshot — it is a
 * normalized projection that:
 *   - Summarizes inference and MCP state into cognitive-friendly fields.
 *   - Strips raw diagnostics detail (health scores, full transition logs, etc.).
 *   - Provides only what Tala needs to reason about her operational environment.
 *
 * Design rules:
 *   - Reads from an already-assembled RuntimeDiagnosticsSnapshot.
 *   - No live service calls — pure projection of existing diagnostics state.
 *   - Degraded and unavailable state is explicit, not silently absent.
 *   - All outputs are IPC-safe and serialization-safe.
 */

import type { RuntimeDiagnosticsSnapshot } from '../../../shared/runtimeDiagnosticsTypes';
import type {
    RuntimeWorldState,
    ToolWorldState,
    ProviderWorldState,
    ServiceWorldState,
    WorldModelSectionMeta,
    WorldModelAvailability,
} from '../../../shared/worldModelTypes';

// ─── Projector ────────────────────────────────────────────────────────────────

/**
 * RuntimeWorldStateProjector
 *
 * Takes a RuntimeDiagnosticsSnapshot and produces the three world-model sections:
 * RuntimeWorldState, ToolWorldState, and ProviderWorldState.
 */
export class RuntimeWorldStateProjector {
    /**
     * Projects the full runtime/tool/provider world state from a diagnostics snapshot.
     *
     * @param snapshot - The current RuntimeDiagnosticsSnapshot.
     * @returns The three projected world-state sections.
     */
    public project(snapshot: RuntimeDiagnosticsSnapshot): {
        runtime: RuntimeWorldState;
        tools: ToolWorldState;
        providers: ProviderWorldState;
    } {
        const now = new Date().toISOString();

        return {
            runtime: this._projectRuntime(snapshot, now),
            tools: this._projectTools(snapshot, now),
            providers: this._projectProviders(snapshot, now),
        };
    }

    /**
     * Produces an unavailable RuntimeWorldState (when diagnostics are not available).
     */
    public buildRuntimeUnavailable(reason: string): RuntimeWorldState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason,
            },
            inferenceReady: false,
            totalProviders: 0,
            readyProviders: 0,
            degradedSubsystems: [],
            hasActiveDegradation: false,
            streamActive: false,
        };
    }

    /**
     * Produces an unavailable ToolWorldState.
     */
    public buildToolsUnavailable(reason: string): ToolWorldState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason,
            },
            enabledTools: [],
            blockedTools: [],
            degradedTools: [],
            mcpServices: [],
            totalMcpServices: 0,
            readyMcpServices: 0,
        };
    }

    /**
     * Produces an unavailable ProviderWorldState.
     */
    public buildProvidersUnavailable(reason: string): ProviderWorldState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason,
            },
            availableProviders: [],
            suppressedProviders: [],
            degradedProviders: [],
            totalProviders: 0,
            lastFallbackApplied: false,
        };
    }

    // ─── Private projection methods ───────────────────────────────────────────

    private _projectRuntime(snapshot: RuntimeDiagnosticsSnapshot, now: string): RuntimeWorldState {
        const inf = snapshot.inference;
        const streamActive =
            inf.streamStatus === 'streaming' ||
            inf.streamStatus === 'opening' ||
            inf.streamStatus === 'pending';

        const hasActiveDegradation = snapshot.degradedSubsystems.length > 0;

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness: 'fresh',
            availability: 'available' as WorldModelAvailability,
        };

        return {
            meta,
            inferenceReady: inf.selectedProviderReady,
            selectedProviderId: inf.selectedProviderId,
            selectedProviderName: inf.selectedProviderName,
            totalProviders: inf.providerInventorySummary.total,
            readyProviders: inf.providerInventorySummary.ready,
            degradedSubsystems: [...snapshot.degradedSubsystems],
            hasActiveDegradation,
            streamActive,
        };
    }

    private _projectTools(snapshot: RuntimeDiagnosticsSnapshot, now: string): ToolWorldState {
        const mcp = snapshot.mcp;

        const mcpServices: ServiceWorldState[] = mcp.services.map((svc) => ({
            serviceId: svc.serviceId,
            displayName: svc.displayName,
            ready: svc.ready,
            degraded: svc.degraded,
            enabled: svc.enabled,
            status: svc.status,
            failureReason: svc.lastFailureReason,
        }));

        // Degraded MCP services contribute to degraded tools list.
        const degradedTools = mcp.services
            .filter((svc) => svc.degraded || !svc.ready)
            .map((svc) => svc.serviceId);

        const enabledTools = mcp.services
            .filter((svc) => svc.enabled && svc.ready)
            .map((svc) => svc.serviceId);

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness: 'fresh',
            availability: 'available',
        };

        return {
            meta,
            enabledTools,
            blockedTools: [],  // Policy-blocked tools are not tracked in MCP diagnostics; leave empty.
            degradedTools,
            mcpServices,
            totalMcpServices: mcp.totalConfigured,
            readyMcpServices: mcp.totalReady,
        };
    }

    private _projectProviders(snapshot: RuntimeDiagnosticsSnapshot, now: string): ProviderWorldState {
        const inf = snapshot.inference;
        const healthScores = snapshot.providerHealthScores ?? [];

        const suppressed = (snapshot.suppressedProviders ?? []).slice();
        const degradedProviders = healthScores
            .filter((s) => s.failureStreak >= 2 && !s.suppressed)
            .map((s) => s.providerId);

        // Available = ready providers. We derive from healthScores if present,
        // otherwise rely on providerInventorySummary.
        const availableProviders: string[] = healthScores
            .filter((s) => !s.suppressed && s.failureStreak < 2)
            .map((s) => s.providerId);

        // If healthScores is empty but inventory says providers are ready, note selected.
        const effectiveAvailable =
            availableProviders.length === 0 && inf.selectedProviderId && inf.selectedProviderReady
                ? [inf.selectedProviderId]
                : availableProviders;

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness: 'fresh',
            availability: 'available',
        };

        return {
            meta,
            preferredProviderId: inf.selectedProviderId,
            preferredProviderName: inf.selectedProviderName,
            availableProviders: effectiveAvailable,
            suppressedProviders: suppressed,
            degradedProviders,
            totalProviders: inf.providerInventorySummary.total,
            lastFallbackApplied: inf.fallbackApplied,
        };
    }
}

/** Module-level singleton. */
export const runtimeWorldStateProjector = new RuntimeWorldStateProjector();
