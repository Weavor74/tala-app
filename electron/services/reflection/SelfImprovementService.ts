import { ReflectionIssue } from './reflectionEcosystemTypes';
import { RepoInspectionService } from './RepoInspectionService';
import { ClusteredIssue, LogInspectionService } from './LogInspectionService';

export class SelfImprovementService {
    private repoInspector: RepoInspectionService;
    private logInspector: LogInspectionService;

    constructor(repoInspector: RepoInspectionService, logInspector: LogInspectionService) {
        this.repoInspector = repoInspector;
        this.logInspector = logInspector;
    }

    /**
     * PHASE 1: OBSERVE
     * Scans recent context to build a formal ReflectionIssue.
     */
    public async scanIssue(trigger: string, requestedMode: string, requestedBy: string = 'internal_heartbeat'): Promise<ReflectionIssue> {
        console.log(`[SelfImprovement] Scanning for new issue triggered by: ${trigger}`);

        const evidence = await this.logInspector.buildIssueEvidenceBundle();
        const clusters: ClusteredIssue[] = Array.isArray(evidence.issueClusters) ? evidence.issueClusters : [];

        let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
        if (evidence.errors && evidence.errors.length > 5) severity = 'medium';
        if (evidence.errors && evidence.errors.length > 20) severity = 'high';

        const topCluster = clusters[0];
        if (topCluster) {
            severity = topCluster.computedSeverity;
        }

        // Draft an initial issue. (Real implementation would use an LLM call here to summarize symptoms from evidence).
        const issueId = `issue_${Date.now()}`;
        const escalationSummary = topCluster?.escalationReasons?.length
            ? `Escalation reasons: ${topCluster.escalationReasons.join(', ')}`
            : 'Escalation reasons: none';

        const issue: ReflectionIssue = {
            issueId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            title: topCluster
                ? `Auto-Detected Issue: ${topCluster.family}`
                : `Auto-Detected Issue: ${trigger}`,
            trigger,
            mode: requestedMode,
            severity,
            confidence: topCluster?.confidence ?? 0.8,
            symptoms: topCluster ? [
                `Cluster family: ${topCluster.family}`,
                `Cluster events: ${topCluster.eventCount}`,
                `Cluster prior runs: ${topCluster.priorRunCount}`,
                escalationSummary,
                `Errors found in logs: ${evidence.errors ? evidence.errors.length : 0}`,
            ] : [`Errors found in logs: ${evidence.errors ? evidence.errors.length : 0}`],
            reproductionSteps: ['Check runtime-errors.jsonl'],
            evidenceRefs: topCluster?.representativeSamples ?? [],
            relatedLogs: topCluster?.sources ?? Object.keys(evidence),
            affectedFiles: [], // To be populated by ReflectionEngine
            probableLayer: topCluster ? topCluster.family.split('.')[0] : 'unknown',
            rootCauseHypotheses: [],
            status: 'open',
            requestedBy,
            source: topCluster ? `Log Cluster:${topCluster.family}` : 'Log Scan',
            issueClusterKey: topCluster?.clusterKey,
            issueFamily: topCluster?.family,
            issueEventCount: topCluster?.eventCount ?? 0,
            issueFirstSeenAt: topCluster?.firstSeenAt,
            issueLastSeenAt: topCluster?.lastSeenAt,
            issueEscalationReasons: topCluster?.escalationReasons ?? [],
            issuePriorRunCount: topCluster?.priorRunCount ?? 0,
        };

        if (clusters.length) {
            this.logInspector.recordIssueClusters(clusters);
        }

        if (topCluster) {
            console.log(`[CandidateScreening] clusterKey=${topCluster.clusterKey} accepted=${severity !== 'low'} severity=${severity}`);
        } else {
            console.log('[CandidateScreening] clusterKey=none accepted=false reason=no_clusters_detected');
        }

        return issue;
    }
}
