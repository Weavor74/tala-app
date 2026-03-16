/**
 * McpLifecycleManager — MCP Lifecycle Diagnostics and Telemetry
 *
 * Wraps McpService to add:
 * - Structured telemetry emission on every state transition
 * - Per-service transition history and failure metadata
 * - Normalized RuntimeStatus projection for diagnostics consumers
 * - Aggregated diagnostics inventory (McpInventoryDiagnostics)
 *
 * Design rules:
 * - McpService is NOT modified for backward compatibility.
 * - This class is the diagnostics-aware companion to McpService.
 * - Transitions are recorded with timestamps and reasons.
 * - Telemetry events mirror the MCP lifecycle event types in shared/telemetry.ts.
 * - Non-critical failures degrade gracefully; no single service collapses the app.
 */

import { ServerState, McpService } from './McpService';
import type { McpServiceHealth } from './McpService';
import { telemetry } from './TelemetryService';
import { ReflectionEngine } from './reflection/ReflectionEngine';
import type {
    RuntimeStatus,
    RuntimeTransitionRecord,
    McpServiceDiagnostics,
    McpInventoryDiagnostics,
} from '../../shared/runtimeDiagnosticsTypes';
import type { McpServiceState } from '../../shared/telemetry';

// ─── Per-service metadata tracked by the manager ─────────────────────────────

interface ServiceMeta {
    serviceId: string;
    displayName: string;
    kind: 'stdio' | 'websocket';
    enabled: boolean;
    lastKnownState: ServerState;
    lastTransitionTime: string;
    lastFailureReason?: string;
    lastHealthCheck?: string;
    restartCount: number;
    recentTransitions: RuntimeTransitionRecord[];
    /** Failure streak for thresholded reflection signals. */
    failureStreak: number;
}

const MAX_TRANSITION_HISTORY = 10;

// ─── Status mapping ───────────────────────────────────────────────────────────

function serverStateToRuntimeStatus(state: ServerState): RuntimeStatus {
    switch (state) {
        case ServerState.CONNECTED:  return 'ready';
        case ServerState.STARTING:   return 'starting';
        case ServerState.DEGRADED:   return 'degraded';
        case ServerState.UNAVAILABLE: return 'unavailable';
        case ServerState.FAILED:     return 'failed';
        case ServerState.DISABLED:   return 'disabled';
        default:                     return 'unknown';
    }
}

function serverStateToMcpState(state: ServerState): McpServiceState {
    switch (state) {
        case ServerState.CONNECTED:   return 'ready';
        case ServerState.STARTING:    return 'starting';
        case ServerState.DEGRADED:    return 'degraded';
        case ServerState.UNAVAILABLE: return 'unavailable';
        case ServerState.FAILED:      return 'failed';
        case ServerState.DISABLED:    return 'disabled';
        default:                      return 'unavailable';
    }
}

// ─── McpLifecycleManager ──────────────────────────────────────────────────────

export class McpLifecycleManager {
    private serviceMeta: Map<string, ServiceMeta> = new Map();
    private lastInventoryUpdate: string = new Date().toISOString();

    constructor(private mcpService: McpService) {}

    // ─── Configuration ────────────────────────────────────────────────────────

    /**
     * Registers a service for lifecycle tracking.
     * Called when the MCP service inventory is initialized or synced.
     */
    public registerService(
        serviceId: string,
        displayName: string,
        kind: 'stdio' | 'websocket',
        enabled: boolean,
    ): void {
        if (!this.serviceMeta.has(serviceId)) {
            const initialState: ServiceMeta = {
                serviceId,
                displayName,
                kind,
                enabled,
                lastKnownState: enabled ? ServerState.STARTING : ServerState.DISABLED,
                lastTransitionTime: new Date().toISOString(),
                restartCount: 0,
                recentTransitions: [],
                failureStreak: 0,
            };
            this.serviceMeta.set(serviceId, initialState);
        } else {
            // Update immutable fields if they changed
            const meta = this.serviceMeta.get(serviceId)!;
            meta.enabled = enabled;
        }
    }

    // ─── Lifecycle notifications (called by McpService wrappers) ─────────────

    /**
     * Called when a service connection attempt starts.
     */
    public onServiceStarting(serviceId: string): void {
        this._transition(serviceId, ServerState.STARTING, 'Connection handshake initiated');
        const meta = this.serviceMeta.get(serviceId);
        telemetry.operational(
            'mcp',
            'mcp_service_starting',
            'info',
            'McpLifecycleManager',
            `MCP service starting: ${meta?.displayName ?? serviceId}`,
            'unknown',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: 'stopped' as McpServiceState,
                    newState: 'starting' as McpServiceState,
                },
            }
        );
    }

    /**
     * Called when a service connection succeeds and becomes ready.
     */
    public onServiceReady(serviceId: string): void {
        const meta = this.serviceMeta.get(serviceId);
        const priorState = meta?.lastKnownState ?? ServerState.STARTING;
        const wasRecovering = priorState === ServerState.DEGRADED || priorState === ServerState.UNAVAILABLE;

        this._transition(serviceId, ServerState.CONNECTED, 'Connection established and capabilities negotiated');
        if (meta) {
            meta.failureStreak = 0;
        }

        const eventType = wasRecovering ? 'mcp_service_recovered' : 'mcp_service_ready';
        telemetry.operational(
            'mcp',
            eventType,
            'info',
            'McpLifecycleManager',
            `MCP service ready: ${meta?.displayName ?? serviceId}`,
            'success',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: serverStateToMcpState(priorState),
                    newState: 'ready' as McpServiceState,
                    restartCount: meta?.restartCount ?? 0,
                },
            }
        );
    }

    /**
     * Called when a service fails a health check and enters degraded state.
     */
    public onServiceDegraded(serviceId: string, reason?: string): void {
        const meta = this.serviceMeta.get(serviceId);
        const priorState = meta?.lastKnownState ?? ServerState.CONNECTED;

        this._transition(serviceId, ServerState.DEGRADED, reason ?? 'Health check failed');
        if (meta) {
            meta.lastFailureReason = reason ?? 'Health check failed';
            meta.failureStreak++;
        }

        telemetry.operational(
            'mcp',
            'mcp_service_degraded',
            'warn',
            'McpLifecycleManager',
            `MCP service degraded: ${meta?.displayName ?? serviceId} — ${reason ?? 'health check failed'}`,
            'failure',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: serverStateToMcpState(priorState),
                    newState: 'degraded' as McpServiceState,
                    reason,
                    restartCount: meta?.restartCount ?? 0,
                },
            }
        );

        this._checkInstabilitySignal(serviceId);
    }

    /**
     * Called when a service becomes unavailable (temporarily unreachable).
     */
    public onServiceUnavailable(serviceId: string, reason?: string): void {
        const meta = this.serviceMeta.get(serviceId);
        const priorState = meta?.lastKnownState ?? ServerState.CONNECTED;

        this._transition(serviceId, ServerState.UNAVAILABLE, reason ?? 'Service unreachable');
        if (meta) {
            meta.lastFailureReason = reason;
            meta.failureStreak++;
        }

        telemetry.operational(
            'mcp',
            'mcp_service_unavailable',
            'warn',
            'McpLifecycleManager',
            `MCP service unavailable: ${meta?.displayName ?? serviceId}`,
            'failure',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: serverStateToMcpState(priorState),
                    newState: 'unavailable' as McpServiceState,
                    reason,
                },
            }
        );
    }

    /**
     * Called when a service has exhausted retries and entered FAILED state.
     */
    public onServiceFailed(serviceId: string, reason?: string, restartCount?: number): void {
        const meta = this.serviceMeta.get(serviceId);
        const priorState = meta?.lastKnownState ?? ServerState.DEGRADED;

        this._transition(serviceId, ServerState.FAILED, reason ?? 'Max retries exhausted');
        if (meta) {
            meta.lastFailureReason = reason ?? 'Max retries exhausted';
            if (restartCount !== undefined) meta.restartCount = restartCount;
        }

        telemetry.operational(
            'mcp',
            'mcp_service_failed',
            'error',
            'McpLifecycleManager',
            `MCP service failed (max retries): ${meta?.displayName ?? serviceId}`,
            'failure',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: serverStateToMcpState(priorState),
                    newState: 'failed' as McpServiceState,
                    reason,
                    restartCount: meta?.restartCount ?? 0,
                },
            }
        );

        ReflectionEngine.reportSignal({
            timestamp: new Date().toISOString(),
            subsystem: 'mcp',
            category: 'mcp_instability',
            description: `MCP service ${meta?.displayName ?? serviceId} entered FAILED state after max retries`,
            context: { serviceId, restartCount: meta?.restartCount ?? 0, reason },
        });
    }

    /**
     * Called when a reconnect attempt begins for a degraded service.
     */
    public onServiceRecovering(serviceId: string): void {
        const meta = this.serviceMeta.get(serviceId);
        const priorState = meta?.lastKnownState ?? ServerState.DEGRADED;
        if (meta) meta.restartCount++;

        this._transition(serviceId, ServerState.DEGRADED, 'Reconnect attempt in progress');

        telemetry.operational(
            'mcp',
            'mcp_service_recovering',
            'info',
            'McpLifecycleManager',
            `MCP service recovering: ${meta?.displayName ?? serviceId} (attempt ${meta?.restartCount ?? 1})`,
            'unknown',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    priorState: serverStateToMcpState(priorState),
                    newState: 'recovering' as McpServiceState,
                    restartCount: meta?.restartCount ?? 1,
                },
            }
        );
    }

    /**
     * Records a completed health check result.
     */
    public onHealthCheckCompleted(serviceId: string, healthy: boolean, durationMs?: number): void {
        const meta = this.serviceMeta.get(serviceId);
        if (meta) meta.lastHealthCheck = new Date().toISOString();

        const eventType = healthy ? 'mcp_health_check_completed' : 'mcp_health_check_failed';
        telemetry.operational(
            'mcp',
            eventType,
            healthy ? 'debug' : 'warn',
            'McpLifecycleManager',
            `MCP health check ${healthy ? 'passed' : 'failed'}: ${meta?.displayName ?? serviceId}`,
            healthy ? 'success' : 'failure',
            {
                payload: {
                    serviceId,
                    serviceKind: meta?.kind ?? 'stdio',
                    healthy,
                    durationMs,
                    retryCount: meta?.restartCount ?? 0,
                },
            }
        );
    }

    /**
     * Emits an inventory snapshot telemetry event.
     * Called after sync() or after any significant inventory change.
     */
    public onInventoryRefreshed(): void {
        const inv = this.getDiagnosticsInventory();
        this.lastInventoryUpdate = new Date().toISOString();

        telemetry.operational(
            'mcp',
            'mcp_inventory_refreshed',
            'info',
            'McpLifecycleManager',
            `MCP inventory refreshed: ${inv.totalReady}/${inv.totalConfigured} ready`,
            'success',
            {
                payload: {
                    totalConfigured: inv.totalConfigured,
                    totalReady: inv.totalReady,
                    totalDegraded: inv.totalDegraded,
                    totalUnavailable: inv.totalUnavailable,
                },
            }
        );
    }

    // ─── State synchronization ────────────────────────────────────────────────

    /**
     * Synchronizes lifecycle metadata from current McpService health reports.
     * Auto-registers any services present in McpService but not yet tracked.
     * Call this after mcpService.sync() or at regular intervals.
     */
    public syncFromService(): void {
        const allHealth = this.mcpService.getAllServiceHealth();
        for (const health of allHealth) {
            if (!this.serviceMeta.has(health.serverId)) {
                // Auto-register previously unknown services
                this.registerService(
                    health.serverId,
                    health.name,
                    'stdio', // Default kind — McpServiceHealth doesn't expose transport type
                    health.state !== ServerState.DISABLED,
                );
            }
            const meta = this.serviceMeta.get(health.serverId);
            if (!meta) continue;

            const prev = meta.lastKnownState;
            if (prev !== health.state) {
                this._applyTransitionFromHealth(health, prev);
            }
        }
    }

    // ─── Read API ─────────────────────────────────────────────────────────────

    /**
     * Returns the normalized diagnostics inventory for all registered services.
     * Auto-includes any services present in McpService that are not yet in serviceMeta.
     */
    public getDiagnosticsInventory(): McpInventoryDiagnostics {
        const allHealth = this.mcpService.getAllServiceHealth();
        const healthById = new Map<string, McpServiceHealth>();
        for (const h of allHealth) healthById.set(h.serverId, h);

        // Include all services from both serviceMeta and any auto-discovered from health
        const allServiceIds = new Set<string>([
            ...this.serviceMeta.keys(),
            ...healthById.keys(),
        ]);

        const services: McpServiceDiagnostics[] = [];
        for (const id of allServiceIds) {
            const meta = this.serviceMeta.get(id);
            const health = healthById.get(id);
            const state = health?.state ?? (meta?.enabled ? ServerState.UNAVAILABLE : ServerState.DISABLED);
            const runtimeStatus = serverStateToRuntimeStatus(state);

            services.push({
                serviceId: id,
                displayName: meta?.displayName ?? health?.name ?? id,
                kind: meta?.kind ?? 'stdio',
                enabled: meta?.enabled ?? (state !== ServerState.DISABLED),
                status: runtimeStatus,
                degraded: state === ServerState.DEGRADED,
                ready: state === ServerState.CONNECTED,
                lastHealthCheck: meta?.lastHealthCheck,
                lastTransitionTime: meta?.lastTransitionTime,
                lastFailureReason: meta?.lastFailureReason ?? (health?.statusMessage !== 'Service is ready and accepting tool calls.' ? health?.statusMessage : undefined),
                restartCount: meta?.restartCount ?? health?.retryCount ?? 0,
            });
        }

        const totalReady = services.filter(s => s.ready).length;
        const totalDegraded = services.filter(s => s.degraded).length;
        const totalUnavailable = services.filter(
            s => s.status === 'unavailable' || s.status === 'failed'
        ).length;

        return {
            services,
            totalConfigured: services.length,
            totalReady,
            totalDegraded,
            totalUnavailable,
            criticalUnavailable: false, // No critical designation in current policy
            lastUpdated: this.lastInventoryUpdate,
        };
    }

    /**
     * Returns diagnostics for a single service by ID.
     */
    public getServiceDiagnostics(serviceId: string): McpServiceDiagnostics | null {
        const inv = this.getDiagnosticsInventory();
        return inv.services.find(s => s.serviceId === serviceId) ?? null;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _transition(serviceId: string, newState: ServerState, reason: string): void {
        const meta = this.serviceMeta.get(serviceId);
        if (!meta) return;

        const prev = meta.lastKnownState;
        const now = new Date().toISOString();

        const record: RuntimeTransitionRecord = {
            timestamp: now,
            fromStatus: serverStateToRuntimeStatus(prev),
            toStatus: serverStateToRuntimeStatus(newState),
            reason,
        };

        meta.lastKnownState = newState;
        meta.lastTransitionTime = now;
        meta.recentTransitions.push(record);
        if (meta.recentTransitions.length > MAX_TRANSITION_HISTORY) {
            meta.recentTransitions.shift();
        }
    }

    private _applyTransitionFromHealth(health: McpServiceHealth, prevState: ServerState): void {
        const meta = this.serviceMeta.get(health.serverId);
        if (!meta) return;

        switch (health.state) {
            case ServerState.CONNECTED:
                if (prevState !== ServerState.CONNECTED) this.onServiceReady(health.serverId);
                break;
            case ServerState.DEGRADED:
                if (prevState !== ServerState.DEGRADED) this.onServiceDegraded(health.serverId, health.statusMessage);
                break;
            case ServerState.FAILED:
                if (prevState !== ServerState.FAILED) this.onServiceFailed(health.serverId, health.statusMessage, health.retryCount);
                break;
            case ServerState.UNAVAILABLE:
                if (prevState !== ServerState.UNAVAILABLE) this.onServiceUnavailable(health.serverId, health.statusMessage);
                break;
        }
    }

    private _checkInstabilitySignal(serviceId: string): void {
        const meta = this.serviceMeta.get(serviceId);
        if (!meta) return;

        // Emit repeated_mcp_restart signal after threshold
        const INSTABILITY_THRESHOLD = 3;
        if (meta.failureStreak >= INSTABILITY_THRESHOLD) {
            ReflectionEngine.reportSignal({
                timestamp: new Date().toISOString(),
                subsystem: 'mcp',
                category: 'mcp_instability',
                description: `MCP service ${meta.displayName} has been degraded ${meta.failureStreak} times consecutively`,
                context: {
                    serviceId,
                    failureStreak: meta.failureStreak,
                    lastFailureReason: meta.lastFailureReason,
                    restartCount: meta.restartCount,
                },
            });
        }
    }
}
