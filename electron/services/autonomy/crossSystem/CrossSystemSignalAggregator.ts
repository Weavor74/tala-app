/**
 * CrossSystemSignalAggregator.ts — Phase 6 P6B
 *
 * Signal aggregation across all subsystems.
 *
 * Responsibilities:
 * - Accept signals from any subsystem (execution, governance, harmonization, etc.)
 * - Maintain a bounded, windowed in-memory signal buffer
 * - Deduplicate signals with the same sourceType+subsystem+failureType within proximity window
 * - Provide query methods for the clustering engine
 *
 * Bounds:
 *   MAX_SIGNALS_PER_WINDOW signals per window
 *   SIGNAL_WINDOW_MS time window
 *
 * All operations are synchronous.
 */

import { telemetry } from '../../TelemetryService';
import type { CrossSystemSignal, SignalSourceType } from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';

// ─── Deduplication window ─────────────────────────────────────────────────────

/** Signals with the same key observed within this window are duplicates. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── CrossSystemSignalAggregator ──────────────────────────────────────────────

export class CrossSystemSignalAggregator {
    /** Bounded in-memory signal buffer for the current window. */
    private signals: CrossSystemSignal[] = [];

    // ── Ingestion ───────────────────────────────────────────────────────────────

    /**
     * Ingests a signal into the current window.
     *
     * Returns false (without ingesting) if:
     * - The window is at MAX_SIGNALS_PER_WINDOW capacity
     * - An identical signal (same sourceType+subsystem+failureType) was ingested
     *   within DEDUP_WINDOW_MS
     *
     * Returns true if the signal was accepted.
     */
    ingest(signal: CrossSystemSignal): boolean {
        // Trim expired signals first to keep the window current
        this._trimExpired();

        // Capacity check
        if (this.signals.length >= CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'CrossSystemSignalAggregator',
                `Signal window at capacity (${CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW}); ` +
                `dropping signal ${signal.signalId} (${signal.sourceType}/${signal.subsystem})`,
            );
            return false;
        }

        // Deduplication check
        if (this._isDuplicate(signal)) {
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'CrossSystemSignalAggregator',
                `Duplicate signal suppressed: ${signal.sourceType}/${signal.subsystem}/${signal.failureType}`,
            );
            return false;
        }

        this.signals.push(signal);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'CrossSystemSignalAggregator',
            `Signal ingested: ${signal.signalId} (${signal.sourceType}/${signal.subsystem}/${signal.failureType}) ` +
            `severity=${signal.severity} window=${this.signals.length}/${CROSS_SYSTEM_BOUNDS.MAX_SIGNALS_PER_WINDOW}`,
        );

        return true;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns all signals currently within the active time window.
     * Trims expired signals before returning.
     */
    getWindowedSignals(): CrossSystemSignal[] {
        this._trimExpired();
        return [...this.signals];
    }

    /**
     * Returns all windowed signals from the given subsystem.
     */
    getSignalsBySubsystem(subsystem: string): CrossSystemSignal[] {
        this._trimExpired();
        return this.signals.filter(s => s.subsystem === subsystem);
    }

    /**
     * Returns all windowed signals of the given source type.
     */
    getSignalsBySourceType(sourceType: SignalSourceType): CrossSystemSignal[] {
        this._trimExpired();
        return this.signals.filter(s => s.sourceType === sourceType);
    }

    /**
     * Returns the current count of signals in the window (after trimming expired).
     */
    getSignalCount(): number {
        this._trimExpired();
        return this.signals.length;
    }

    /**
     * Flushes all signals from the buffer. Used for testing and manual reset.
     */
    clear(): void {
        this.signals = [];
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Removes signals whose timestamp falls outside the current SIGNAL_WINDOW_MS.
     */
    private _trimExpired(): void {
        const cutoff = Date.now() - CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS;
        this.signals = this.signals.filter(
            s => new Date(s.timestamp).getTime() >= cutoff,
        );
    }

    /**
     * Returns true if a signal with the same sourceType+subsystem+failureType
     * was ingested within DEDUP_WINDOW_MS.
     */
    private _isDuplicate(signal: CrossSystemSignal): boolean {
        const cutoff = Date.now() - DEDUP_WINDOW_MS;
        return this.signals.some(
            s =>
                s.sourceType === signal.sourceType &&
                s.subsystem === signal.subsystem &&
                s.failureType === signal.failureType &&
                new Date(s.timestamp).getTime() >= cutoff,
        );
    }
}
