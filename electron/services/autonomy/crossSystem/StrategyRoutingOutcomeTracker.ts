/**
 * StrategyRoutingOutcomeTracker.ts — Phase 6.1 P6.1F
 *
 * Records and tracks the outcomes of strategy routing decisions.
 *
 * Responsibilities:
 * - Persist StrategyRoutingOutcomeRecord to disk (routing_outcomes.json)
 * - Track whether a routing decision proved effective
 * - Compute an overall trust score for the routing layer
 * - Purge old records beyond OUTCOME_RETENTION_MS
 * - Support recurrence detection (same cluster reappearing)
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    StrategyRoutingOutcomeRecord,
    StrategyRoutingOutcomeId,
    StrategyRoutingDecisionId,
    StrategyRoutingTargetType,
} from '../../../../shared/strategyRoutingTypes';
import { STRATEGY_ROUTING_BOUNDS } from '../../../../shared/strategyRoutingTypes';
import { telemetry } from '../../TelemetryService';

// ─── Storage ──────────────────────────────────────────────────────────────────

const OUTCOMES_FILE = 'routing_outcomes.json';

// ─── StrategyRoutingOutcomeTracker ────────────────────────────────────────────

export class StrategyRoutingOutcomeTracker {
    private readonly storageDir: string;
    private outcomes: StrategyRoutingOutcomeRecord[] = [];
    private loaded = false;

    constructor(dataDir: string) {
        this.storageDir = path.join(dataDir, 'autonomy', 'strategy_routing');
        this._ensureDir(this.storageDir);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Records a routing outcome.
     * Persists to disk immediately.
     */
    record(outcome: StrategyRoutingOutcomeRecord): void {
        this._ensureLoaded();
        this.outcomes.push(outcome);
        this._persist();

        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'StrategyRoutingOutcomeTracker',
            `Outcome recorded: ${outcome.outcomeId} ` +
            `routingDecisionId=${outcome.routingDecisionId} ` +
            `targetType=${outcome.targetType} ` +
            `actionCompleted=${outcome.actionCompleted} ` +
            `trustDelta=${outcome.trustDelta}`,
        );
    }

    /**
     * Creates and records a new outcome with a generated ID.
     * Returns the generated outcome ID.
     */
    createAndRecord(params: {
        routingDecisionId: StrategyRoutingDecisionId;
        clusterId: string;
        targetType: StrategyRoutingTargetType;
        actionId: string;
        routingCorrect: boolean | undefined;
        actionCompleted: boolean;
        actionSucceeded: boolean | undefined;
        strategyValidated: boolean | undefined;
        notes: string;
    }): StrategyRoutingOutcomeId {
        const outcomeId: StrategyRoutingOutcomeId = `srout-${uuidv4()}`;
        const trustDelta = this._computeTrustDelta(
            params.actionCompleted,
            params.actionSucceeded,
            params.routingCorrect,
        );

        const outcome: StrategyRoutingOutcomeRecord = {
            outcomeId,
            routingDecisionId: params.routingDecisionId,
            clusterId: params.clusterId,
            targetType: params.targetType,
            actionId: params.actionId,
            routingCorrect: params.routingCorrect,
            actionCompleted: params.actionCompleted,
            actionSucceeded: params.actionSucceeded,
            strategyValidated: params.strategyValidated,
            trustDelta,
            recordedAt: new Date().toISOString(),
            notes: params.notes,
        };

        this.record(outcome);
        return outcomeId;
    }

    /**
     * Lists all outcome records, optionally filtered by routingDecisionId.
     */
    listOutcomes(filter?: { routingDecisionId?: string }): StrategyRoutingOutcomeRecord[] {
        this._ensureLoaded();
        if (!filter?.routingDecisionId) return [...this.outcomes];
        return this.outcomes.filter(o => o.routingDecisionId === filter.routingDecisionId);
    }

    /**
     * Returns the most recent N outcomes, newest first.
     */
    getRecent(n = 20): StrategyRoutingOutcomeRecord[] {
        this._ensureLoaded();
        return [...this.outcomes]
            .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
            .slice(0, n);
    }

    /**
     * Computes the overall routing trust score (0–1).
     *
     * Formula:
     *   if no outcomes → return 0.5 (neutral)
     *   posWeight = sum of positive trustDeltas
     *   negWeight = abs(sum of negative trustDeltas)
     *   score = (posWeight + count * 0.5) / (posWeight + negWeight + count * 0.5)
     *   clamped to [0, 1]
     */
    computeOverallTrustScore(): number {
        this._ensureLoaded();
        if (this.outcomes.length === 0) return 0.5;

        let posWeight = 0;
        let negWeight = 0;
        for (const o of this.outcomes) {
            if (o.trustDelta > 0) posWeight += o.trustDelta;
            else negWeight += Math.abs(o.trustDelta);
        }

        const n = this.outcomes.length;
        const score = (posWeight + n * 0.5) / (posWeight + negWeight + n * 0.5);
        return Math.max(0, Math.min(1, score));
    }

    /**
     * Counts outcomes grouped by a given field for KPI computation.
     */
    countByTargetType(): Map<StrategyRoutingTargetType, number> {
        this._ensureLoaded();
        const counts = new Map<StrategyRoutingTargetType, number>();
        for (const o of this.outcomes) {
            counts.set(o.targetType, (counts.get(o.targetType) ?? 0) + 1);
        }
        return counts;
    }

    /**
     * Returns the number of outcomes where routingCorrect === true.
     */
    countRoutingCorrect(): number {
        this._ensureLoaded();
        return this.outcomes.filter(o => o.routingCorrect === true).length;
    }

    /**
     * Purges outcome records older than OUTCOME_RETENTION_MS.
     * Called on load.
     */
    purgeOldRecords(): void {
        const cutoff = Date.now() - STRATEGY_ROUTING_BOUNDS.OUTCOME_RETENTION_MS;
        const before = this.outcomes.length;
        this.outcomes = this.outcomes.filter(
            o => new Date(o.recordedAt).getTime() >= cutoff,
        );
        const purged = before - this.outcomes.length;
        if (purged > 0) {
            this._persist();
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'StrategyRoutingOutcomeTracker',
                `Purged ${purged} old routing outcome record(s).`,
            );
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Computes a trust delta for a given outcome.
     * Range: -1 to +1.
     */
    private _computeTrustDelta(
        actionCompleted: boolean,
        actionSucceeded: boolean | undefined,
        routingCorrect: boolean | undefined,
    ): number {
        if (!actionCompleted) return -0.2; // incomplete actions reduce trust slightly
        if (actionSucceeded === true && routingCorrect === true) return 1.0;
        if (actionSucceeded === true && routingCorrect === undefined) return 0.5;
        if (actionSucceeded === false && routingCorrect === true) return 0.0;  // route was right, action failed
        if (actionSucceeded === false && routingCorrect === false) return -1.0;
        if (actionSucceeded === false) return -0.5;
        return 0.0;
    }

    private _ensureLoaded(): void {
        if (!this.loaded) {
            this._load();
            this.loaded = true;
        }
    }

    private _load(): void {
        const file = path.join(this.storageDir, OUTCOMES_FILE);
        if (!fs.existsSync(file)) {
            this.outcomes = [];
            return;
        }
        try {
            this.outcomes = JSON.parse(fs.readFileSync(file, 'utf-8')) as StrategyRoutingOutcomeRecord[];
            this.purgeOldRecords();
        } catch {
            this.outcomes = [];
        }
    }

    private _persist(): void {
        const file = path.join(this.storageDir, OUTCOMES_FILE);
        try {
            fs.writeFileSync(file, JSON.stringify(this.outcomes, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'StrategyRoutingOutcomeTracker',
                `Failed to persist routing outcomes: ${err.message}`,
            );
        }
    }

    private _ensureDir(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            // non-fatal
        }
    }
}
