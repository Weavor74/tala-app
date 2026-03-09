import { ReflectionIssue } from './reflectionEcosystemTypes';
import { RepoInspectionService } from './RepoInspectionService';
import { LogInspectionService } from './LogInspectionService';

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

        let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
        if (evidence.errors && evidence.errors.length > 5) severity = 'medium';
        if (evidence.errors && evidence.errors.length > 20) severity = 'high';

        // Draft an initial issue. (Real implementation would use an LLM call here to summarize symptoms from evidence).
        const issueId = `issue_${Date.now()}`;

        const issue: ReflectionIssue = {
            issueId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            title: `Auto-Detected Issue: ${trigger}`,
            trigger,
            mode: requestedMode,
            severity,
            confidence: 0.8,
            symptoms: [`Errors found in logs: ${evidence.errors ? evidence.errors.length : 0}`],
            reproductionSteps: ['Check runtime-errors.jsonl'],
            evidenceRefs: [],
            relatedLogs: Object.keys(evidence),
            affectedFiles: [], // To be populated by ReflectionEngine
            probableLayer: 'unknown',
            rootCauseHypotheses: [],
            status: 'open',
            requestedBy,
            source: 'Log Scan'
        };

        return issue;
    }
}
