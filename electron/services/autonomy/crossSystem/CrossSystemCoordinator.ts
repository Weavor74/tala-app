/**
 * CrossSystemCoordinator.ts — Phase 6 P6F
 *
 * Orchestrates cross-system intelligence analysis.
 *
 * Responsibilities:
 * - Receive ingested signals from AutonomousRunOrchestrator
 * - Run clustering, root cause analysis, and strategy selection
 * - Persist clusters, root causes, and decisions to disk
 * - Track outcomes and serve dashboard state
 *
 * Called from AutonomousRunOrchestrator.ingestCrossSystemSignal() at the end
 * of each run's finally block (like campaign outcome tracking).
 *
 * Loop guard: one analysis pass at a time (re-entrancy protected).
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    CrossSystemSignal,
    IncidentCluster,
    RootCauseHypothesis,
    StrategyDecisionRecord,
    CrossSystemOutcomeRecord,
    CrossSystemDashboardState,
    ClusterId,
} from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';
import type { CrossSystemSignalAggregator } from './CrossSystemSignalAggregator';
import type { IncidentClusteringEngine } from './IncidentClusteringEngine';
import type { RootCauseAnalyzer } from './RootCauseAnalyzer';
import type { CrossSystemStrategySelector } from './CrossSystemStrategySelector';
import type { CrossSystemOutcomeTracker } from './CrossSystemOutcomeTracker';
import type { CrossSystemDashboardBridge } from './CrossSystemDashboardBridge';
import type { CrossSystemSignalCollector } from './CrossSystemSignalCollector';
import { telemetry } from '../../TelemetryService';

// ─── Analysis trigger threshold ───────────────────────────────────────────────

/** Run analysis automatically when the buffered signal count reaches this value. */
const ANALYSIS_TRIGGER_THRESHOLD = CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER * 2; // 4

// ─── Storage file names ────────────────────────────────────────────────────────

const CLUSTERS_FILE  = 'clusters.json';
const DECISIONS_FILE = 'decisions.json';
const ROOT_CAUSES_FILE = 'root_causes.json';

// ─── CrossSystemCoordinator ───────────────────────────────────────────────────

export class CrossSystemCoordinator {
    private readonly storageDir: string;

    /** In-memory cluster registry. */
    private clusters: IncidentCluster[] = [];
    /** In-memory root cause hypotheses. */
    private rootCauses: RootCauseHypothesis[] = [];
    /** In-memory strategy decision records. */
    private decisions: StrategyDecisionRecord[] = [];

    /** Re-entrancy guard for runAnalysis(). */
    private analysisInProgress = false;

    private stateLoaded = false;

    /** Optional signal collector for pull-based ingestion from existing registries. */
    private signalCollector: CrossSystemSignalCollector | undefined;

    constructor(
        dataDir: string,
        private readonly aggregator: CrossSystemSignalAggregator,
        private readonly clusteringEngine: IncidentClusteringEngine,
        private readonly rootCauseAnalyzer: RootCauseAnalyzer,
        private readonly strategySelector: CrossSystemStrategySelector,
        private readonly outcomeTracker: CrossSystemOutcomeTracker,
        private readonly dashboardBridge: CrossSystemDashboardBridge,
    ) {
        this.storageDir = path.join(dataDir, 'autonomy', 'cross_system');
        this._ensureDir(this.storageDir);
    }

    // ── Signal ingestion ────────────────────────────────────────────────────────

    /**
     * Registers an optional CrossSystemSignalCollector for pull-based ingestion.
     * When set, collectAndIngest() pulls signals from all registered sources.
     */
    setSignalCollector(collector: CrossSystemSignalCollector): void {
        this.signalCollector = collector;
    }

    /**
     * Ingests a signal into the aggregator.
     * Automatically triggers a full analysis pass when the signal count
     * crosses ANALYSIS_TRIGGER_THRESHOLD.
     */
    ingestSignal(signal: CrossSystemSignal): void {
        const accepted = this.aggregator.ingest(signal);
        if (!accepted) return;

        const count = this.aggregator.getSignalCount();
        if (count >= ANALYSIS_TRIGGER_THRESHOLD) {
            this.runAnalysis();
        }

        // Push a lightweight signal-ingested update to the dashboard
        this.dashboardBridge.maybeEmit('signals_ingested', this._buildCurrentState());
    }

    /**
     * Pulls signals from all registered source registries (execution, harmonization,
     * escalation, campaigns) via the optional CrossSystemSignalCollector, then
     * ingests each signal into the aggregator.
     *
     * Deduplication is handled by CrossSystemSignalAggregator.ingest().
     * This method is called at the start of each analysis loop tick.
     * No-op when no collector is registered.
     */
    collectAndIngest(): void {
        if (!this.signalCollector) return;

        try {
            const signals = this.signalCollector.collect();
            let accepted = 0;
            for (const signal of signals) {
                if (this.aggregator.ingest(signal)) {
                    accepted++;
                }
            }
            if (accepted > 0) {
                telemetry.operational('autonomy', 'operational', 'debug', 'CrossSystemCoordinator',
                    `collectAndIngest() pulled ${signals.length} signal(s), accepted ${accepted} new`);
                this.dashboardBridge.maybeEmit('signals_ingested', this._buildCurrentState());
            }
        } catch (err: any) {
            telemetry.operational('autonomy', 'operational', 'warn', 'CrossSystemCoordinator',
                `collectAndIngest() failed: ${err.message}`);
        }
    }

    // ── Analysis pipeline ───────────────────────────────────────────────────────

    /**
     * Runs the full cross-system intelligence pipeline:
     *   1. Cluster signals
     *   2. Analyze root causes for new/updated clusters
     *   3. Select strategy for clusters without a current decision
     *   4. Persist state
     *   5. Push dashboard update
     *
     * Re-entrancy protected — concurrent calls are silently dropped.
     */
    runAnalysis(): void {
        if (this.analysisInProgress) {
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'CrossSystemCoordinator',
                'runAnalysis() re-entrancy guard triggered — skipping concurrent pass',
            );
            return;
        }

        this.analysisInProgress = true;

        try {
            if (!this.stateLoaded) this._loadState();

            // ── Step 0: Pull signals from registered source registries ─────────
            // collectAndIngest() can be called repeatedly — repeated records produce new signal IDs
            // but the aggregator deduplicates by sourceType+subsystem+failureType within DEDUP_WINDOW_MS
            this.collectAndIngest();

            const signals = this.aggregator.getWindowedSignals();
            if (signals.length < CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER) {
                return;
            }

            // ── Step 1: Cluster signals ───────────────────────────────────────
            const updatedClusters = this.clusteringEngine.cluster(signals, this.clusters);
            const newClusters = updatedClusters.filter(
                c => !this.clusters.some(e => e.clusterId === c.clusterId),
            );
            this.clusters = updatedClusters;

            if (newClusters.length > 0) {
                this.dashboardBridge.maybeEmit('cluster_formed', this._buildCurrentState());
            }

            // ── Step 2: Root cause analysis for open clusters ─────────────────
            const openClusters = this.clusters.filter(c => c.status === 'open');

            for (const cluster of openClusters) {
                // Skip clusters that already have a root cause
                if (cluster.rootCauseId) continue;

                const hypotheses = this.rootCauseAnalyzer.analyze(cluster, signals);
                if (hypotheses.length === 0) continue;

                // Link top hypothesis to cluster
                const top = hypotheses[0];
                cluster.rootCauseId = top.rootCauseId;

                // Merge new hypotheses (avoid duplicates by rootCauseId)
                for (const h of hypotheses) {
                    if (!this.rootCauses.some(r => r.rootCauseId === h.rootCauseId)) {
                        this.rootCauses.push(h);
                    }
                }
            }

            this.dashboardBridge.maybeEmit('root_cause_analyzed', this._buildCurrentState());

            // ── Step 3: Strategy selection for undecided open clusters ─────────
            for (const cluster of openClusters) {
                // Skip if a decision already exists for this cluster
                const alreadyDecided = this.decisions.some(
                    d => d.clusterId === cluster.clusterId,
                );
                if (alreadyDecided) continue;

                const clusterHypotheses = this.rootCauses
                    .filter(r => r.clusterId === cluster.clusterId)
                    .sort((a, b) => b.score - a.score);

                const decision = this.strategySelector.select(cluster, clusterHypotheses);
                this.decisions.push(decision);
            }

            this.dashboardBridge.maybeEmit('strategy_decided', this._buildCurrentState());

            // ── Step 4: Persist state ─────────────────────────────────────────
            this._persistClusters();
            this._persistDecisions();
            this._persistRootCauses();

            telemetry.operational(
                'autonomy',
                'operational',
                'info',
                'CrossSystemCoordinator',
                `Analysis pass complete: ${signals.length} signal(s), ` +
                `${openClusters.length} open cluster(s), ` +
                `${newClusters.length} new cluster(s), ` +
                `${this.decisions.length} total decision(s)`,
            );
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'error',
                'CrossSystemCoordinator',
                `Analysis pass failed: ${err.message}`,
            );
        } finally {
            this.analysisInProgress = false;
        }
    }

    // ── Outcome recording ───────────────────────────────────────────────────────

    /**
     * Records the outcome of a strategy execution.
     *
     * @param outcomeId  Caller-supplied stable outcome identifier (prefixed `csout-`).
     * @param clusterId  The cluster this outcome addresses.
     * @param succeeded  Whether the strategy resolved the cluster.
     * @param notes      Human-readable outcome notes.
     */
    recordOutcome(
        outcomeId: string,
        clusterId: ClusterId,
        succeeded: boolean,
        notes: string,
    ): void {
        if (!this.stateLoaded) this._loadState();

        // Find the most recent decision for this cluster
        const linkedDecision = [...this.decisions]
            .filter(d => d.clusterId === clusterId)
            .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime())[0];

        const outcome: CrossSystemOutcomeRecord = {
            outcomeId,
            clusterId,
            rootCauseId: linkedDecision?.rootCauseId,
            strategyUsed: linkedDecision?.strategySelected ?? 'defer',
            decisionId: linkedDecision?.decisionId ?? '',
            executedAt: new Date().toISOString(),
            resolvedAt: succeeded ? new Date().toISOString() : undefined,
            succeeded,
            recurred: false,
            notes,
        };

        this.outcomeTracker.record(outcome);

        // Mark the cluster as addressed if succeeded
        if (succeeded) {
            const cluster = this.clusters.find(c => c.clusterId === clusterId);
            if (cluster) {
                cluster.status = 'addressed';
                this._persistClusters();
            }
        }

        this.dashboardBridge.maybeEmit('outcome_recorded', this._buildCurrentState());

        telemetry.operational(
            'autonomy',
            'operational',
            succeeded ? 'info' : 'warn',
            'CrossSystemCoordinator',
            `Outcome recorded: ${outcomeId} cluster=${clusterId} succeeded=${succeeded}`,
        );
    }

    // ── Query methods ───────────────────────────────────────────────────────────

    getDashboardState(): CrossSystemDashboardState {
        if (!this.stateLoaded) this._loadState();
        return this._buildCurrentState();
    }

    getOpenClusters(): IncidentCluster[] {
        if (!this.stateLoaded) this._loadState();
        return this.clusters.filter(c => c.status === 'open');
    }

    getCluster(clusterId: ClusterId): IncidentCluster | null {
        if (!this.stateLoaded) this._loadState();
        return this.clusters.find(c => c.clusterId === clusterId) ?? null;
    }

    getRootCauses(clusterId: ClusterId): RootCauseHypothesis[] {
        if (!this.stateLoaded) this._loadState();
        return this.rootCauses.filter(r => r.clusterId === clusterId);
    }

    getRecentDecisions(windowMs?: number): StrategyDecisionRecord[] {
        if (!this.stateLoaded) this._loadState();
        if (!windowMs) return [...this.decisions];
        const cutoff = Date.now() - windowMs;
        return this.decisions.filter(
            d => new Date(d.decidedAt).getTime() >= cutoff,
        );
    }

    // ── Private: state builder ──────────────────────────────────────────────────

    private _buildCurrentState(): CrossSystemDashboardState {
        const outcomes = this.outcomeTracker.listOutcomes();
        return this.dashboardBridge.buildState(
            this.clusters,
            this.rootCauses,
            this.decisions,
            outcomes,
            this.aggregator.getSignalCount(),
        );
    }

    // ── Private: persistence ────────────────────────────────────────────────────

    private _persistClusters(): void {
        this._writeJson(CLUSTERS_FILE, this.clusters);
    }

    private _loadClusters(): void {
        this.clusters = this._readJson<IncidentCluster[]>(CLUSTERS_FILE) ?? [];
    }

    private _persistDecisions(): void {
        this._writeJson(DECISIONS_FILE, this.decisions);
    }

    private _loadDecisions(): void {
        this.decisions = this._readJson<StrategyDecisionRecord[]>(DECISIONS_FILE) ?? [];
    }

    private _persistRootCauses(): void {
        this._writeJson(ROOT_CAUSES_FILE, this.rootCauses);
    }

    private _loadRootCauses(): void {
        this.rootCauses = this._readJson<RootCauseHypothesis[]>(ROOT_CAUSES_FILE) ?? [];
    }

    private _loadState(): void {
        this._loadClusters();
        this._loadDecisions();
        this._loadRootCauses();
        this.stateLoaded = true;
    }

    private _writeJson(filename: string, data: unknown): void {
        const file = path.join(this.storageDir, filename);
        try {
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'CrossSystemCoordinator',
                `Failed to write ${filename}: ${err.message}`,
            );
        }
    }

    private _readJson<T>(filename: string): T | null {
        const file = path.join(this.storageDir, filename);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
        } catch {
            return null;
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
