/**
 * RuntimeControlService — Operational Control for Runtime Subsystems
 *
 * Phase 2B Objective A + G
 *
 * Provides safe, telemetry-tracked runtime control operations for:
 * - Inference providers (restart, disable, enable, force-select, probe)
 * - MCP services (restart, disable, enable, probe)
 *
 * Safety rules:
 * - No destructive operations (no permanent removal, no forced shutdown without telemetry)
 * - All actions are reversible
 * - All actions emit structured telemetry with entityId, priorState, newState, reason
 * - Probing is debounced to prevent runaway re-probe storms
 * - The renderer never calls this directly — only IPC handlers do
 *
 * Reflection integration:
 * - operator_intervention_required emitted if a provider requires 3+ manual restarts
 * - mcp_service_flapping emitted if an MCP service is restarted repeatedly
 */

import { v4 as uuidv4 } from 'uuid';
import { telemetry } from './TelemetryService';
import { ReflectionEngine } from './reflection/ReflectionEngine';
import { providerHealthScorer } from './inference/ProviderHealthScorer';
import type { InferenceService } from './InferenceService';
import type { McpLifecycleManager } from './McpLifecycleManager';
import type { McpService } from './McpService';
import type { OperatorActionRecord } from '../../shared/runtimeDiagnosticsTypes';
import type { McpServerConfig } from '../../shared/settings';

// ─── Action result ────────────────────────────────────────────────────────────

export interface ControlActionResult {
    success: boolean;
    entityId: string;
    action: OperatorActionRecord['action'];
    priorState?: string;
    newState?: string;
    correlationId: string;
    error?: string;
}

// ─── Debounce tracking ────────────────────────────────────────────────────────

const PROBE_DEBOUNCE_MS = 5000;

// ─── MCP restart tracking for flapping detection ─────────────────────────────

const MCP_FLAPPING_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MCP_FLAPPING_THRESHOLD = 3;

// ─── RuntimeControlService ────────────────────────────────────────────────────

export class RuntimeControlService {
    /** Ring buffer of recent operator actions (max 50). */
    private operatorActions: OperatorActionRecord[] = [];
    private lastProbeTime: number = 0;
    private lastMcpProbeTime: number = 0;
    private mcpRestartHistory: Map<string, number[]> = new Map();
    private providerRecoveries: Array<{ providerId: string; timestamp: string; reason: string }> = [];
    private mcpRestarts: Array<{ serviceId: string; timestamp: string; reason: string }> = [];

    constructor(
        private readonly inferenceService: InferenceService,
        private readonly mcpLifecycle: McpLifecycleManager,
        private readonly mcpService: McpService,
    ) {}

    // ─── Provider Controls ─────────────────────────────────────────────────────

    /**
     * Re-probes and refreshes the given provider.
     * Emits provider_restart_requested/completed telemetry.
     */
    public async restartProvider(providerId: string): Promise<ControlActionResult> {
        const correlationId = uuidv4();
        const inventory = this.inferenceService.getProviderInventory();
        const provider = inventory.providers.find(p => p.providerId === providerId);
        const priorState = provider?.status ?? 'unknown';

        telemetry.operational(
            'inference',
            'provider_restart_requested',
            'info',
            'RuntimeControlService',
            `Provider restart requested: ${providerId}`,
            'unknown',
            {
                correlationId,
                payload: {
                    entityId: providerId,
                    entityType: 'provider',
                    priorState,
                    reason: 'Operator initiated restart',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        try {
            await this.inferenceService.refreshProviders();
            const updated = this.inferenceService.getProviderInventory();
            const newProvider = updated.providers.find(p => p.providerId === providerId);
            const newState = newProvider?.status ?? 'unknown';

            providerHealthScorer.resetScore(providerId);
            providerHealthScorer.recordRestart(providerId);

            telemetry.operational(
                'inference',
                'provider_restart_completed',
                'info',
                'RuntimeControlService',
                `Provider restart completed: ${providerId} → ${newState}`,
                'success',
                {
                    correlationId,
                    payload: {
                        entityId: providerId,
                        entityType: 'provider',
                        priorState,
                        newState,
                        timestamp: new Date().toISOString(),
                        correlationId,
                    },
                }
            );

            const record = this._recordAction({
                action: 'provider_restart',
                entityId: providerId,
                entityType: 'provider',
                priorState,
                newState,
                correlationId,
                reason: 'Operator initiated restart',
            });

            return { success: true, entityId: providerId, action: 'provider_restart', priorState, newState, correlationId };
        } catch (err: any) {
            const errMsg = err?.message ?? String(err);
            this._recordAction({
                action: 'provider_restart',
                entityId: providerId,
                entityType: 'provider',
                priorState,
                reason: `Restart failed: ${errMsg}`,
                correlationId,
            });
            return { success: false, entityId: providerId, action: 'provider_restart', priorState, correlationId, error: errMsg };
        }
    }

    /**
     * Re-probes all providers.
     * Debounced to prevent probe storms.
     */
    public async probeProviders(): Promise<ControlActionResult> {
        const correlationId = uuidv4();
        const now = Date.now();
        if (now - this.lastProbeTime < PROBE_DEBOUNCE_MS) {
            return { success: false, entityId: 'all', action: 'provider_probe', correlationId, error: 'Probe debounced — too soon after last probe' };
        }
        this.lastProbeTime = now;

        try {
            await this.inferenceService.refreshProviders();
            this._recordAction({ action: 'provider_probe', entityId: 'all', entityType: 'provider', correlationId, reason: 'Operator initiated probe' });
            return { success: true, entityId: 'all', action: 'provider_probe', correlationId };
        } catch (err: any) {
            return { success: false, entityId: 'all', action: 'provider_probe', correlationId, error: err?.message ?? String(err) };
        }
    }

    /**
     * Suppresses a provider from auto-selection (session-scoped disable).
     * Does not permanently remove the provider.
     */
    public disableProvider(providerId: string, reason?: string): ControlActionResult {
        const correlationId = uuidv4();
        const inventory = this.inferenceService.getProviderInventory();
        const provider = inventory.providers.find(p => p.providerId === providerId);
        const priorState = provider?.status ?? 'unknown';

        // Directly suppress without simulating failures (avoids misleading telemetry/history)
        providerHealthScorer.suppressProvider(providerId, provider?.priority ?? 1);

        telemetry.operational(
            'inference',
            'provider_disabled',
            'warn',
            'RuntimeControlService',
            `Provider disabled: ${providerId}`,
            'success',
            {
                correlationId,
                payload: {
                    entityId: providerId,
                    entityType: 'provider',
                    priorState,
                    newState: 'disabled',
                    reason: reason ?? 'Operator disabled',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        this._recordAction({ action: 'provider_disable', entityId: providerId, entityType: 'provider', priorState, newState: 'disabled', correlationId, reason });
        return { success: true, entityId: providerId, action: 'provider_disable', priorState, newState: 'disabled', correlationId };
    }

    /**
     * Re-enables a previously suppressed provider.
     */
    public enableProvider(providerId: string, reason?: string): ControlActionResult {
        const correlationId = uuidv4();
        const inventory = this.inferenceService.getProviderInventory();
        const provider = inventory.providers.find(p => p.providerId === providerId);
        const priorState = 'disabled';

        providerHealthScorer.resetScore(providerId);

        telemetry.operational(
            'inference',
            'provider_enabled',
            'info',
            'RuntimeControlService',
            `Provider re-enabled: ${providerId}`,
            'success',
            {
                correlationId,
                payload: {
                    entityId: providerId,
                    entityType: 'provider',
                    priorState,
                    newState: provider?.status ?? 'configured',
                    reason: reason ?? 'Operator enabled',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        const newState = provider?.status ?? 'configured';
        this._recordAction({ action: 'provider_enable', entityId: providerId, entityType: 'provider', priorState, newState, correlationId, reason });

        this.providerRecoveries.push({ providerId, timestamp: new Date().toISOString(), reason: reason ?? 'Operator re-enabled' });
        if (this.providerRecoveries.length > 20) this.providerRecoveries.shift();

        return { success: true, entityId: providerId, action: 'provider_enable', priorState, newState, correlationId };
    }

    /**
     * Forces selection of a specific provider for the current session.
     */
    public forceProviderSelection(providerId: string, reason?: string): ControlActionResult {
        const correlationId = uuidv4();
        const inventory = this.inferenceService.getProviderInventory();
        const priorSelected = inventory.selectedProviderId ?? 'auto';

        this.inferenceService.setSelectedProvider(providerId);

        telemetry.operational(
            'inference',
            'provider_selected',
            'info',
            'RuntimeControlService',
            `Provider force-selected: ${providerId} (was: ${priorSelected})`,
            'success',
            {
                correlationId,
                payload: {
                    entityId: providerId,
                    entityType: 'provider',
                    priorState: priorSelected,
                    newState: providerId,
                    reason: reason ?? 'Operator force-selected',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        this._recordAction({ action: 'provider_force_select', entityId: providerId, entityType: 'provider', priorState: priorSelected, newState: providerId, correlationId, reason });
        return { success: true, entityId: providerId, action: 'provider_force_select', priorState: priorSelected, newState: providerId, correlationId };
    }

    // ─── MCP Controls ──────────────────────────────────────────────────────────

    /**
     * Restarts an MCP service by disconnecting and reconnecting.
     */
    public async restartMcpService(serviceId: string, mcpConfigs: McpServerConfig[]): Promise<ControlActionResult> {
        const correlationId = uuidv4();
        const health = this.mcpService.getServiceHealth(serviceId);
        const priorState = health?.state?.toString() ?? 'unknown';

        telemetry.operational(
            'mcp',
            'mcp_service_restart_requested',
            'info',
            'RuntimeControlService',
            `MCP service restart requested: ${serviceId}`,
            'unknown',
            {
                correlationId,
                payload: {
                    entityId: serviceId,
                    entityType: 'mcp_service',
                    priorState,
                    reason: 'Operator initiated restart',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        try {
            this.mcpLifecycle.onServiceStarting(serviceId);
            await this.mcpService.disconnect(serviceId);

            const config = mcpConfigs.find(c => c.id === serviceId);
            let newState = 'restarted';
            if (config) {
                const ok = await this.mcpService.connect(config);
                newState = ok ? 'ready' : 'failed';
                if (ok) {
                    this.mcpLifecycle.onServiceReady(serviceId);
                } else {
                    this.mcpLifecycle.onServiceFailed(serviceId, 'Reconnect failed after restart');
                }
            }

            telemetry.operational(
                'mcp',
                'mcp_service_restart_completed',
                newState === 'ready' ? 'info' : 'warn',
                'RuntimeControlService',
                `MCP service restart completed: ${serviceId} → ${newState}`,
                newState === 'ready' ? 'success' : 'failure',
                {
                    correlationId,
                    payload: {
                        entityId: serviceId,
                        entityType: 'mcp_service',
                        priorState,
                        newState,
                        timestamp: new Date().toISOString(),
                        correlationId,
                    },
                }
            );

            this._recordAction({ action: 'mcp_restart', entityId: serviceId, entityType: 'mcp_service', priorState, newState, correlationId, reason: 'Operator restart' });

            // Track restart for flapping detection
            this._trackMcpRestart(serviceId);

            this.mcpRestarts.push({ serviceId, timestamp: new Date().toISOString(), reason: 'Operator restart' });
            if (this.mcpRestarts.length > 20) this.mcpRestarts.shift();

            return { success: true, entityId: serviceId, action: 'mcp_restart', priorState, newState, correlationId };
        } catch (err: any) {
            const errMsg = err?.message ?? String(err);
            this._recordAction({ action: 'mcp_restart', entityId: serviceId, entityType: 'mcp_service', priorState, correlationId, reason: `Restart failed: ${errMsg}` });
            return { success: false, entityId: serviceId, action: 'mcp_restart', priorState, correlationId, error: errMsg };
        }
    }

    /**
     * Disables an MCP service (prevents invocation, disconnects it).
     */
    public async disableMcpService(serviceId: string): Promise<ControlActionResult> {
        const correlationId = uuidv4();
        const health = this.mcpService.getServiceHealth(serviceId);
        const priorState = health?.state?.toString() ?? 'unknown';

        await this.mcpService.disconnect(serviceId);

        telemetry.operational(
            'mcp',
            'mcp_service_disabled',
            'warn',
            'RuntimeControlService',
            `MCP service disabled: ${serviceId}`,
            'success',
            {
                correlationId,
                payload: {
                    entityId: serviceId,
                    entityType: 'mcp_service',
                    priorState,
                    newState: 'disabled',
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        this._recordAction({ action: 'mcp_disable', entityId: serviceId, entityType: 'mcp_service', priorState, newState: 'disabled', correlationId });
        return { success: true, entityId: serviceId, action: 'mcp_disable', priorState, newState: 'disabled', correlationId };
    }

    /**
     * Re-enables a previously disabled MCP service.
     */
    public async enableMcpService(serviceId: string, mcpConfigs: McpServerConfig[]): Promise<ControlActionResult> {
        const correlationId = uuidv4();
        const config = mcpConfigs.find(c => c.id === serviceId);
        if (!config) {
            return { success: false, entityId: serviceId, action: 'mcp_enable', correlationId, error: 'Service config not found' };
        }

        let newState = 'connecting';
        try {
            const ok = await this.mcpService.connect({ ...config, enabled: true });
            newState = ok ? 'ready' : 'failed';
            if (ok) {
                this.mcpLifecycle.onServiceReady(serviceId);
            }
        } catch (err: any) {
            newState = 'failed';
        }

        telemetry.operational(
            'mcp',
            'mcp_service_enabled',
            'info',
            'RuntimeControlService',
            `MCP service enabled: ${serviceId} → ${newState}`,
            newState === 'ready' ? 'success' : 'failure',
            {
                correlationId,
                payload: {
                    entityId: serviceId,
                    entityType: 'mcp_service',
                    priorState: 'disabled',
                    newState,
                    timestamp: new Date().toISOString(),
                    correlationId,
                },
            }
        );

        this._recordAction({ action: 'mcp_enable', entityId: serviceId, entityType: 'mcp_service', priorState: 'disabled', newState, correlationId });
        return { success: true, entityId: serviceId, action: 'mcp_enable', priorState: 'disabled', newState, correlationId };
    }

    /**
     * Triggers a health check / re-probe of all MCP services.
     * Debounced to prevent probe storms.
     */
    public probeMcpServices(): ControlActionResult {
        const correlationId = uuidv4();
        const now = Date.now();
        if (now - this.lastMcpProbeTime < PROBE_DEBOUNCE_MS) {
            return { success: false, entityId: 'all', action: 'mcp_probe', correlationId, error: 'Probe debounced' };
        }
        this.lastMcpProbeTime = now;

        this.mcpLifecycle.onInventoryRefreshed();
        this._recordAction({ action: 'mcp_probe', entityId: 'all', entityType: 'mcp_service', correlationId, reason: 'Operator health probe' });
        return { success: true, entityId: 'all', action: 'mcp_probe', correlationId };
    }

    // ─── Snapshot read API ─────────────────────────────────────────────────────

    /** Returns recent operator actions (capped to last 50). */
    public getOperatorActions(): OperatorActionRecord[] {
        return [...this.operatorActions];
    }

    /** Returns recent provider recovery events. */
    public getRecentProviderRecoveries(): Array<{ providerId: string; timestamp: string; reason: string }> {
        return [...this.providerRecoveries];
    }

    /** Returns recent MCP restart events. */
    public getRecentMcpRestarts(): Array<{ serviceId: string; timestamp: string; reason: string }> {
        return [...this.mcpRestarts];
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _recordAction(
        partial: Omit<OperatorActionRecord, 'timestamp'> & { timestamp?: string }
    ): OperatorActionRecord {
        const record: OperatorActionRecord = {
            timestamp: partial.timestamp ?? new Date().toISOString(),
            action: partial.action,
            entityId: partial.entityId,
            entityType: partial.entityType,
            priorState: partial.priorState,
            newState: partial.newState,
            reason: partial.reason,
            correlationId: partial.correlationId,
        };
        this.operatorActions.push(record);
        if (this.operatorActions.length > 50) {
            this.operatorActions.shift();
        }
        return record;
    }

    private _trackMcpRestart(serviceId: string): void {
        const now = Date.now();
        if (!this.mcpRestartHistory.has(serviceId)) {
            this.mcpRestartHistory.set(serviceId, []);
        }
        const history = this.mcpRestartHistory.get(serviceId)!;
        history.push(now);

        const cutoff = now - MCP_FLAPPING_WINDOW_MS;
        const recent = history.filter(t => t >= cutoff);
        this.mcpRestartHistory.set(serviceId, recent);

        if (recent.length >= MCP_FLAPPING_THRESHOLD) {
            ReflectionEngine.reportThresholdedSignal(
                {
                    timestamp: new Date().toISOString(),
                    subsystem: 'mcp',
                    category: 'mcp_service_flapping',
                    description: `MCP service ${serviceId} restarted ${recent.length} times within ${MCP_FLAPPING_WINDOW_MS / 60000} minutes`,
                    context: { serviceId, restartCount: recent.length, windowMs: MCP_FLAPPING_WINDOW_MS },
                },
                recent.length,
                MCP_FLAPPING_THRESHOLD,
            );

            if (recent.length >= MCP_FLAPPING_THRESHOLD + 2) {
                ReflectionEngine.reportSignal({
                    timestamp: new Date().toISOString(),
                    subsystem: 'mcp',
                    category: 'operator_intervention_required',
                    description: `MCP service ${serviceId} requires operator intervention — persistent restart loop`,
                    context: { serviceId, restartCount: recent.length },
                });
            }
        }
    }
}
