/**
 * InferenceDiagnosticsService — Inference State Read Model
 *
 * Maintains the authoritative normalized diagnostics state for the inference
 * subsystem. Updated by InferenceService as it processes provider selections
 * and stream executions. Read by RuntimeDiagnosticsAggregator.
 *
 * Design rules:
 * - All mutations go through explicit record* methods.
 * - State is never inferred from raw log output.
 * - Timestamps accompany every recorded failure or transition.
 * - The service is a singleton (module-level export).
 */

import type {
    InferenceDiagnosticsState,
    ProviderInventorySummary,
    StreamDiagnosticsStatus,
} from '../../shared/runtimeDiagnosticsTypes';
import type {
    InferenceProviderInventory,
    InferenceProviderDescriptor,
    StreamInferenceResult,
} from '../../shared/inferenceProviderTypes';

// ─── Default state ────────────────────────────────────────────────────────────

function buildDefaultState(): InferenceDiagnosticsState {
    return {
        selectedProviderReady: false,
        attemptedProviders: [],
        fallbackApplied: false,
        streamStatus: 'idle',
        providerInventorySummary: { total: 0, ready: 0, unavailable: 0, degraded: 0 },
        lastUpdated: new Date().toISOString(),
    };
}

// ─── InferenceDiagnosticsService ─────────────────────────────────────────────

export class InferenceDiagnosticsService {
    private state: InferenceDiagnosticsState = buildDefaultState();

    // ─── Write API (called by InferenceService) ───────────────────────────────

    /**
     * Records that a provider was selected (from selectProvider()).
     * Called before stream execution begins.
     */
    public recordProviderSelected(provider: InferenceProviderDescriptor): void {
        this.state = {
            ...this.state,
            selectedProviderId: provider.providerId,
            selectedProviderName: provider.displayName,
            selectedProviderType: provider.providerType,
            selectedProviderReady: provider.ready,
            lastUpdated: new Date().toISOString(),
        };
    }

    /**
     * Records that a stream execution has started.
     * Called at the entry of InferenceService.executeStream().
     */
    public recordStreamStart(providerId: string, attemptedProviders: string[]): void {
        this.state = {
            ...this.state,
            streamStatus: 'opening',
            lastUsedProviderId: providerId,
            attemptedProviders,
            fallbackApplied: false,
            lastUpdated: new Date().toISOString(),
        };
    }

    /**
     * Records that an active stream is flowing (first token received).
     */
    public recordStreamActive(): void {
        this.state = {
            ...this.state,
            streamStatus: 'streaming',
            lastUpdated: new Date().toISOString(),
        };
    }

    /**
     * Records the result of a completed (success or failure) stream execution.
     * Called at the end of InferenceService.executeStream().
     */
    public recordStreamResult(result: StreamInferenceResult): void {
        const streamStatus = this._mapStreamStatus(result.streamStatus);
        const now = new Date().toISOString();

        this.state = {
            ...this.state,
            streamStatus,
            lastStreamStatus: streamStatus,
            lastUsedProviderId: result.providerId,
            attemptedProviders: result.attemptedProviders,
            fallbackApplied: result.fallbackApplied,
            lastFailureReason: result.success ? this.state.lastFailureReason : (result.errorMessage ?? undefined),
            lastFailureTime: result.success ? this.state.lastFailureTime : now,
            lastTimeoutTime: result.streamStatus === 'timeout' ? now : this.state.lastTimeoutTime,
            lastUpdated: now,
        };
    }

    /**
     * Updates the provider inventory summary from a refreshed inventory.
     * Called after InferenceService.refreshProviders() completes.
     */
    public updateFromInventory(inventory: InferenceProviderInventory): void {
        const summary = this._buildInventorySummary(inventory);
        const selected = inventory.selectedProviderId
            ? inventory.providers.find(p => p.providerId === inventory.selectedProviderId)
            : undefined;

        this.state = {
            ...this.state,
            selectedProviderId: selected?.providerId ?? this.state.selectedProviderId,
            selectedProviderName: selected?.displayName ?? this.state.selectedProviderName,
            selectedProviderType: selected?.providerType ?? this.state.selectedProviderType,
            selectedProviderReady: selected?.ready ?? this.state.selectedProviderReady,
            providerInventorySummary: summary,
            lastUpdated: new Date().toISOString(),
        };
    }

    // ─── Read API (called by RuntimeDiagnosticsAggregator) ───────────────────

    /**
     * Returns the current normalized inference diagnostics state.
     * The returned object is a shallow copy — callers must not mutate it.
     */
    public getState(): InferenceDiagnosticsState {
        return { ...this.state };
    }

    /**
     * Resets state to default (useful for testing).
     */
    public reset(): void {
        this.state = buildDefaultState();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _mapStreamStatus(raw: string): StreamDiagnosticsStatus {
        switch (raw) {
            case 'opened':    return 'opening';
            case 'streaming': return 'streaming';
            case 'completed': return 'completed';
            case 'aborted':   return 'aborted';
            case 'timeout':   return 'timed_out';
            case 'failed':    return 'failed';
            default:          return 'idle';
        }
    }

    private _buildInventorySummary(inventory: InferenceProviderInventory): ProviderInventorySummary {
        const providers = inventory.providers;
        return {
            total: providers.length,
            ready: providers.filter(p => p.ready).length,
            unavailable: providers.filter(p => p.status === 'unavailable' || p.status === 'not_running').length,
            degraded: providers.filter(p => p.status === 'degraded').length,
        };
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

/**
 * Singleton InferenceDiagnosticsService instance.
 * Import and use this in InferenceService and RuntimeDiagnosticsAggregator.
 */
export const inferenceDiagnostics = new InferenceDiagnosticsService();
