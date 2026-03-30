/**
 * CrossSystemSignalCollector.ts — Phase 6 P6B (active collection)
 *
 * Pulls cross-system signals from existing subsystem registries and trackers.
 *
 * This complements the push-based CrossSystemSignalAggregator.ingest() path
 * by actively reading historical records from the subsystem data stores.
 *
 * Sources collected:
 *   - Execution runs (failed/rolled_back/governance_blocked)  → AutonomyAuditService
 *   - Harmonization outcomes (failed/rolled_back)             → HarmonizationOutcomeTracker
 *   - Escalation logs (escalation_requested)                  → EscalationAuditTracker
 *   - Campaign outcomes (failed/rolled_back)                  → CampaignOutcomeTracker
 *
 * Safety bounds:
 *   MAX_COLLECT_PER_SOURCE — hard cap on records pulled from any single source
 *   Collection window matches SIGNAL_WINDOW_MS (4h default)
 *
 * Design principles:
 * - Read-only — never modifies source data
 * - Deterministic — given the same records, always produces the same signals
 * - Deduplication is handled by CrossSystemSignalAggregator.ingest()
 * - No model calls, no network I/O
 */

import { v4 as uuidv4 } from 'uuid';
import type { CrossSystemSignal, SignalSourceType } from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';
import type { AutonomousRun } from '../../../../shared/autonomyTypes';
import type { CampaignOutcomeSummary } from '../../../../shared/repairCampaignTypes';
import type { HarmonizationOutcomeRecord } from '../../../../shared/harmonizationTypes';
import type { EscalationAuditRecord } from '../../../../shared/escalationTypes';
import { telemetry } from '../../TelemetryService';

// ─── Bounds ───────────────────────────────────────────────────────────────────

/** Maximum records pulled from any single source per collect() call. */
const MAX_COLLECT_PER_SOURCE = 50;

// ─── Source provider interfaces ───────────────────────────────────────────────

/**
 * Minimal interface required from AutonomyAuditService.
 * Only the read path is required.
 */
export interface ExecutionRunSource {
    listRuns(windowMs?: number): AutonomousRun[];
}

/**
 * Minimal interface required from HarmonizationOutcomeTracker.
 */
export interface HarmonizationOutcomeSource {
    listOutcomes(windowMs?: number): HarmonizationOutcomeRecord[];
}

/**
 * Minimal interface required from EscalationAuditTracker.
 */
export interface EscalationAuditSource {
    getRecent(limit?: number): EscalationAuditRecord[];
}

/**
 * Minimal interface required from CampaignOutcomeTracker.
 */
export interface CampaignOutcomeSource {
    listOutcomes(windowMs?: number): CampaignOutcomeSummary[];
}

// ─── CrossSystemSignalCollector ───────────────────────────────────────────────

/**
 * Actively collects CrossSystemSignals from existing subsystem registries.
 *
 * Usage:
 *   const collector = new CrossSystemSignalCollector();
 *   collector.setExecutionSource(auditService);
 *   collector.setHarmonizationSource(harmonizationOutcomeTracker);
 *   collector.setEscalationSource(escalationAuditTracker);
 *   collector.setCampaignSource(campaignOutcomeTracker);
 *
 *   const signals = collector.collect();
 *   for (const signal of signals) {
 *       aggregator.ingest(signal);
 *   }
 */
export class CrossSystemSignalCollector {
    private executionSource: ExecutionRunSource | undefined;
    private harmonizationSource: HarmonizationOutcomeSource | undefined;
    private escalationSource: EscalationAuditSource | undefined;
    private campaignSource: CampaignOutcomeSource | undefined;

    // ── Source registration ─────────────────────────────────────────────────────

    setExecutionSource(source: ExecutionRunSource): void {
        this.executionSource = source;
    }

    setHarmonizationSource(source: HarmonizationOutcomeSource): void {
        this.harmonizationSource = source;
    }

    setEscalationSource(source: EscalationAuditSource): void {
        this.escalationSource = source;
    }

    setCampaignSource(source: CampaignOutcomeSource): void {
        this.campaignSource = source;
    }

    // ── Collection ──────────────────────────────────────────────────────────────

    /**
     * Collects cross-system signals from all registered sources.
     *
     * Pulls records within SIGNAL_WINDOW_MS from each source, converts them
     * to CrossSystemSignal objects, and returns the combined list.
     *
     * Deduplication is the responsibility of CrossSystemSignalAggregator.ingest().
     * This method never modifies source data.
     *
     * @returns Array of signals, newest first, capped at
     *          MAX_COLLECT_PER_SOURCE × number_of_sources.
     */
    collect(): CrossSystemSignal[] {
        const signals: CrossSystemSignal[] = [];
        const windowMs = CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS;

        try {
            signals.push(...this._collectExecutionSignals(windowMs));
        } catch (err: any) {
            telemetry.operational('autonomy', 'operational', 'warn', 'CrossSystemSignalCollector',
                `Failed to collect execution signals: ${err.message}`);
        }

        try {
            signals.push(...this._collectHarmonizationSignals(windowMs));
        } catch (err: any) {
            telemetry.operational('autonomy', 'operational', 'warn', 'CrossSystemSignalCollector',
                `Failed to collect harmonization signals: ${err.message}`);
        }

        try {
            signals.push(...this._collectEscalationSignals());
        } catch (err: any) {
            telemetry.operational('autonomy', 'operational', 'warn', 'CrossSystemSignalCollector',
                `Failed to collect escalation signals: ${err.message}`);
        }

        try {
            signals.push(...this._collectCampaignSignals(windowMs));
        } catch (err: any) {
            telemetry.operational('autonomy', 'operational', 'warn', 'CrossSystemSignalCollector',
                `Failed to collect campaign signals: ${err.message}`);
        }

        telemetry.operational('autonomy', 'operational', 'debug', 'CrossSystemSignalCollector',
            `collect() produced ${signals.length} signal(s) from ${this._activeSources()} active source(s)`);

        return signals;
    }

    // ── Private per-source collectors ───────────────────────────────────────────

    /**
     * Converts failed/rolled_back/governance_blocked execution runs into signals.
     *
     * @param windowMs - Collection window in ms. Passed to listRuns() so that only
     *   runs within the configured SIGNAL_WINDOW_MS are returned. This parameter is
     *   required here; callers always provide CROSS_SYSTEM_BOUNDS.SIGNAL_WINDOW_MS.
     */
    private _collectExecutionSignals(windowMs: number): CrossSystemSignal[] {
        if (!this.executionSource) return [];

        const runs = this.executionSource.listRuns(windowMs)
            .filter(r =>
                r.status === 'failed' ||
                r.status === 'rolled_back' ||
                r.status === 'governance_blocked',
            )
            .slice(0, MAX_COLLECT_PER_SOURCE);

        return runs.map(run => {
            const sourceType: SignalSourceType =
                run.status === 'governance_blocked' ? 'governance_block' :
                run.status === 'rolled_back' ? 'verification_failure' :
                'execution_failure';

            return this._makeSignal({
                sourceType,
                subsystem: run.subsystemId,
                failureType: run.failureReason ?? run.status,
                severity: run.status === 'rolled_back' ? 'high' : 'medium',
                timestamp: run.completedAt ?? run.startedAt,
                goalId: run.goalId,
                runId: run.runId,
                affectedFiles: [],
                metadata: { executionRunId: run.executionRunId ?? '' },
            });
        });
    }

    /**
     * Converts failed harmonization outcomes into signals.
     */
    private _collectHarmonizationSignals(windowMs: number): CrossSystemSignal[] {
        if (!this.harmonizationSource) return [];

        const outcomes = this.harmonizationSource.listOutcomes(windowMs)
            .filter(o => !o.succeeded)
            .slice(0, MAX_COLLECT_PER_SOURCE);

        return outcomes.map(o => this._makeSignal({
            sourceType: 'harmonization_drift',
            subsystem: o.subsystem,
            failureType: o.regressionDetected ? 'regression_detected' : o.finalStatus,
            severity: o.regressionDetected ? 'high' : 'medium',
            timestamp: o.endedAt,
            campaignId: o.campaignId,
            affectedFiles: [],
            metadata: { ruleId: o.ruleId, patternClass: o.patternClass },
        }));
    }

    /**
     * Converts escalation_requested audit records into signals.
     */
    private _collectEscalationSignals(): CrossSystemSignal[] {
        if (!this.escalationSource) return [];

        const records = this.escalationSource.getRecent(MAX_COLLECT_PER_SOURCE)
            .filter(r => r.eventKind === 'escalation_requested');

        return records.map(r => this._makeSignal({
            sourceType: 'escalation_attempt',
            subsystem: (r.data?.['subsystem'] as string | undefined) ?? 'unknown',
            failureType: (r.data?.['reason'] as string | undefined) ?? 'escalation_requested',
            severity: 'medium',
            timestamp: r.recordedAt,
            goalId: r.goalId,
            runId: r.runId,
            affectedFiles: [],
            metadata: r.data ?? {},
        }));
    }

    /**
     * Converts failed/rolled_back campaign outcomes into signals.
     */
    private _collectCampaignSignals(windowMs: number): CrossSystemSignal[] {
        if (!this.campaignSource) return [];

        const outcomes = this.campaignSource.listOutcomes(windowMs)
            .filter(o => !o.succeeded)
            .slice(0, MAX_COLLECT_PER_SOURCE);

        return outcomes.map(o => this._makeSignal({
            sourceType: 'campaign_failure',
            subsystem: o.subsystem,
            failureType: o.finalStatus,
            severity: o.rolledBack ? 'high' : 'medium',
            timestamp: o.completedAt,
            goalId: o.goalId,
            campaignId: o.campaignId,
            affectedFiles: [],
            metadata: { originType: o.originType },
        }));
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private _makeSignal(fields: {
        sourceType: SignalSourceType;
        subsystem: string;
        failureType: string;
        severity: 'low' | 'medium' | 'high';
        timestamp: string;
        goalId?: string;
        runId?: string;
        campaignId?: string;
        affectedFiles: string[];
        metadata: Record<string, unknown>;
    }): CrossSystemSignal {
        return {
            signalId: `signal-${uuidv4()}`,
            sourceType: fields.sourceType,
            subsystem: fields.subsystem || 'unknown',
            failureType: fields.failureType || 'unknown',
            severity: fields.severity,
            timestamp: fields.timestamp,
            goalId: fields.goalId,
            runId: fields.runId,
            campaignId: fields.campaignId,
            affectedFiles: fields.affectedFiles,
            metadata: fields.metadata,
        };
    }

    private _activeSources(): number {
        return [
            this.executionSource,
            this.harmonizationSource,
            this.escalationSource,
            this.campaignSource,
        ].filter(Boolean).length;
    }
}
