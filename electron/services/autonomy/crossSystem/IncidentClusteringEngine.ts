/**
 * IncidentClusteringEngine.ts — Phase 6 P6C
 *
 * Groups related signals into bounded incident clusters.
 *
 * Clustering criteria (applied in order, union):
 *   1. shared_subsystem — signals from the same subsystem
 *   2. shared_files — signals referencing overlapping affected files
 *   3. shared_failure_type — signals with the same failureType
 *   4. temporal_proximity — signals within TEMPORAL_PROXIMITY_MS of each other
 *   5. repeated_pattern — same sourceType+subsystem appears ≥3 times
 *
 * Safety bounds:
 *   MAX_CLUSTER_SIZE — cluster is capped; overflow signals are dropped
 *   MAX_CLUSTERS_OPEN — no more than N open clusters at once
 *   MIN_SIGNALS_TO_CLUSTER — a cluster requires at least 2 signals
 *
 * Explainability: every cluster records which clusteringCriteria caused grouping.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    CrossSystemSignal,
    IncidentCluster,
    ClusteringCriterion,
} from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';
import { telemetry } from '../../TelemetryService';

// ─── IncidentClusteringEngine ─────────────────────────────────────────────────

export class IncidentClusteringEngine {
    /**
     * Tracks how many signals contributed each file to a given cluster.
     * Key: `${clusterId}::${filePath}` → count of signals that referenced this file.
     * Used to determine which files qualify as "shared" (appear in >1 signal).
     */
    private fileOccurrences: Map<string, number> = new Map();

    /**
     * Produces an updated cluster list from the supplied signal window.
     *
     * Merges new signals into existing open clusters where applicable,
     * and creates new clusters for unclustered signals.
     *
     * Returns all clusters (new + existing open + non-open clusters unchanged).
     * Clusters with fewer than MIN_SIGNALS_TO_CLUSTER signals are not emitted.
     * Open cluster count is capped at MAX_CLUSTERS_OPEN.
     */
    cluster(
        signals: CrossSystemSignal[],
        existingClusters: IncidentCluster[],
    ): IncidentCluster[] {
        // Partition clusters: open clusters are eligible for merging
        const openClusters = existingClusters.filter(c => c.status === 'open');
        const closedClusters = existingClusters.filter(c => c.status !== 'open');

        // Seed file-occurrence counts from existing open clusters and the current
        // signal window so that the shared-file logic remains correct across
        // incremental calls.
        for (const cluster of openClusters) {
            const clusterSignals = signals.filter(s => cluster.signalIds.includes(s.signalId));
            for (const sig of clusterSignals) {
                for (const f of sig.affectedFiles) {
                    const key = `${cluster.clusterId}::${f}`;
                    if (!this.fileOccurrences.has(key)) {
                        this.fileOccurrences.set(key, 1);
                    }
                }
            }
            // Files already in sharedFiles were seen in ≥2 signals; mark them as ≥2
            for (const f of cluster.sharedFiles) {
                const key = `${cluster.clusterId}::${f}`;
                if ((this.fileOccurrences.get(key) ?? 0) < 2) {
                    this.fileOccurrences.set(key, 2);
                }
            }
        }

        // Working copies (mutable during this pass)
        const workingOpen: IncidentCluster[] = openClusters.map(c => ({ ...c, signalIds: [...c.signalIds] }));
        const newClusters: IncidentCluster[] = [];

        for (const signal of signals) {
            const target = this._findOrCreateCluster(signal, workingOpen, newClusters);
            if (!target) continue; // bounds exceeded — signal dropped

            this._mergeSignalIntoCluster(signal, target);
        }

        // Combine open and new clusters, drop under-threshold clusters
        const allOpen = [...workingOpen, ...newClusters].filter(
            c => c.signalCount >= CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER,
        );

        // Cap at MAX_CLUSTERS_OPEN (prefer clusters with more signals)
        allOpen.sort((a, b) => b.signalCount - a.signalCount);
        const cappedOpen = allOpen.slice(0, CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN);

        if (allOpen.length > CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'IncidentClusteringEngine',
                `Open cluster cap reached (${CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN}); ` +
                `${allOpen.length - CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN} cluster(s) dropped`,
            );
        }

        // Update labels after all signals have been merged
        for (const c of cappedOpen) {
            c.label = this._buildClusterLabel(c);
        }

        const result = [...closedClusters, ...cappedOpen];

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'IncidentClusteringEngine',
            `Clustering pass complete: ${cappedOpen.length} open cluster(s), ` +
            `${closedClusters.length} closed cluster(s), ${signals.length} signal(s) processed`,
        );

        return result;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Finds an existing open cluster or new cluster that this signal should
     * be merged into. Creates a new cluster if none matches.
     *
     * Returns null if the signal cannot be placed (all matching clusters are
     * full and the open-cluster cap is reached).
     */
    private _findOrCreateCluster(
        signal: CrossSystemSignal,
        open: IncidentCluster[],
        newClusters: IncidentCluster[],
    ): IncidentCluster | null {
        // Check if the signal is already tracked in any cluster
        for (const c of [...open, ...newClusters]) {
            if (c.signalIds.includes(signal.signalId)) return c;
        }

        // Try to merge into the best matching existing open cluster
        let bestCluster: IncidentCluster | null = null;
        let bestCriteriaCount = 0;

        for (const c of [...open, ...newClusters]) {
            if (c.signalCount >= CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE) continue;

            // Get signals to compare against (we only have the signal IDs on the cluster,
            // but we can use the cluster's metadata to check overlap)
            const { overlaps, criteria } = this._signalOverlapsCluster(signal, c);
            if (overlaps && criteria.length > bestCriteriaCount) {
                bestCluster = c;
                bestCriteriaCount = criteria.length;
            }
        }

        if (bestCluster) return bestCluster;

        // No matching cluster — create a new one if cap allows
        const totalOpen = open.length + newClusters.length;
        if (totalOpen >= CROSS_SYSTEM_BOUNDS.MAX_CLUSTERS_OPEN) return null;

        const newCluster: IncidentCluster = {
            clusterId: `cluster-${uuidv4()}`,
            label: '',
            signalIds: [],
            subsystems: [],
            sharedFiles: [],
            dominantFailureType: signal.failureType,
            clusteringCriteria: [],
            firstSeenAt: signal.timestamp,
            lastSeenAt: signal.timestamp,
            signalCount: 0,
            severity: signal.severity,
            status: 'open',
        };

        newClusters.push(newCluster);
        return newCluster;
    }

    /**
     * Determines whether a signal overlaps with an existing cluster
     * based on any of the five clustering criteria.
     */
    private _signalOverlapsCluster(
        signal: CrossSystemSignal,
        cluster: IncidentCluster,
    ): { overlaps: boolean; criteria: ClusteringCriterion[] } {
        const criteria: ClusteringCriterion[] = [];

        // shared_subsystem
        if (cluster.subsystems.includes(signal.subsystem)) {
            criteria.push('shared_subsystem');
        }

        // shared_files — any affected file appears in cluster's sharedFiles or could
        // We track all files that appeared in the cluster via dominantFailureType
        // Since we don't store per-signal file lists on the cluster, we check sharedFiles
        if (
            signal.affectedFiles.length > 0 &&
            cluster.sharedFiles.some(f => signal.affectedFiles.includes(f))
        ) {
            criteria.push('shared_files');
        }

        // shared_failure_type
        if (cluster.dominantFailureType === signal.failureType) {
            criteria.push('shared_failure_type');
        }

        // temporal_proximity — signal is within TEMPORAL_PROXIMITY_MS of the cluster's last signal
        const lastSeenMs = new Date(cluster.lastSeenAt).getTime();
        const signalMs = new Date(signal.timestamp).getTime();
        if (Math.abs(signalMs - lastSeenMs) <= CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS) {
            criteria.push('temporal_proximity');
        }

        // repeated_pattern — same sourceType+subsystem already appears ≥2 times in this cluster
        // We approximate: if the cluster already has signals from this subsystem and
        // the cluster signal count for this subsystem would reach 3+
        // (We use signalCount and subsystems as a proxy)
        if (
            cluster.subsystems.includes(signal.subsystem) &&
            cluster.signalCount >= 2
        ) {
            criteria.push('repeated_pattern');
        }

        return { overlaps: criteria.length > 0, criteria };
    }

    /**
     * Determines whether two signals overlap (for initial pair clustering).
     * Used internally; exposed for unit testing via the engine.
     */
    _signalsOverlap(
        a: CrossSystemSignal,
        b: CrossSystemSignal,
    ): { overlaps: boolean; criteria: ClusteringCriterion[] } {
        const criteria: ClusteringCriterion[] = [];

        if (a.subsystem === b.subsystem) {
            criteria.push('shared_subsystem');
        }

        if (
            a.affectedFiles.length > 0 &&
            b.affectedFiles.length > 0 &&
            a.affectedFiles.some(f => b.affectedFiles.includes(f))
        ) {
            criteria.push('shared_files');
        }

        if (a.failureType === b.failureType) {
            criteria.push('shared_failure_type');
        }

        const aMs = new Date(a.timestamp).getTime();
        const bMs = new Date(b.timestamp).getTime();
        if (Math.abs(aMs - bMs) <= CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS) {
            criteria.push('temporal_proximity');
        }

        return { overlaps: criteria.length > 0, criteria };
    }

    /**
     * Merges a signal's data into the cluster, updating all derived fields.
     * Updates the fileOccurrences tracker so sharedFiles is accurate.
     */
    private _mergeSignalIntoCluster(
        signal: CrossSystemSignal,
        cluster: IncidentCluster,
    ): void {
        if (cluster.signalIds.includes(signal.signalId)) return;
        if (cluster.signalCount >= CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE) return;

        cluster.signalIds.push(signal.signalId);
        cluster.signalCount = cluster.signalIds.length;

        // Update subsystems
        if (!cluster.subsystems.includes(signal.subsystem)) {
            cluster.subsystems.push(signal.subsystem);
        }

        // Update file occurrence counts and sharedFiles.
        // A file is "shared" when it has been contributed by more than one signal.
        for (const f of signal.affectedFiles) {
            const key = `${cluster.clusterId}::${f}`;
            const prior = this.fileOccurrences.get(key) ?? 0;
            this.fileOccurrences.set(key, prior + 1);
            // On the second occurrence the file becomes "shared"
            if (prior === 1 && !cluster.sharedFiles.includes(f)) {
                cluster.sharedFiles.push(f);
            }
        }

        // Update timestamps
        const signalMs = new Date(signal.timestamp).getTime();
        if (signalMs < new Date(cluster.firstSeenAt).getTime()) {
            cluster.firstSeenAt = signal.timestamp;
        }
        if (signalMs > new Date(cluster.lastSeenAt).getTime()) {
            cluster.lastSeenAt = signal.timestamp;
        }

        // Update severity (escalate, never de-escalate)
        if (signal.severity === 'high') {
            cluster.severity = 'high';
        } else if (signal.severity === 'medium' && cluster.severity === 'low') {
            cluster.severity = 'medium';
        }

        // Update clustering criteria
        const { criteria } = this._signalOverlapsCluster(signal, cluster);
        for (const c of criteria) {
            if (!cluster.clusteringCriteria.includes(c)) {
                cluster.clusteringCriteria.push(c);
            }
        }

        // Update dominant failure type (most frequent)
        // Simple heuristic: keep existing unless signal failure type is new
        // (full frequency tracking requires signal lookup; use simple majority)
        if (!cluster.dominantFailureType) {
            cluster.dominantFailureType = signal.failureType;
        }
    }

    /**
     * Derives a human-readable label for a cluster from its dominant characteristics.
     */
    private _buildClusterLabel(cluster: IncidentCluster): string {
        const subsystemPart = cluster.subsystems.length === 1
            ? cluster.subsystems[0]
            : `${cluster.subsystems.length} subsystems`;

        const criteriaShort = cluster.clusteringCriteria.length > 0
            ? cluster.clusteringCriteria[0].replace(/_/g, ' ')
            : 'pattern';

        return `${subsystemPart} — ${cluster.dominantFailureType} (${criteriaShort}, ${cluster.signalCount} signals)`;
    }
}
