export type ChangeCategory = 'prompt' | 'workflow' | 'bugfix' | 'docs' | 'test';
export type ChangeType = 'modify' | 'create' | 'delete' | 'patch';
export type RiskScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface ReflectionEvent {
    id: string;
    timestamp: string;
    summary: string;
    evidence: {
        turns: any[];
        errors: string[];
        failedToolCalls: any[];
    };
    observations: string[];
    metrics: {
        averageLatencyMs: number;
        errorRate: number;
    };
}

export interface TelemetryEvent {
    timestamp: string;
    event: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    source: string;
    message: string;
    [key: string]: any;
}

export interface ChangeProposal {
    id: string;
    reflectionId: string;
    category: ChangeCategory;
    title: string;
    description: string;
    risk: {
        score: RiskScore;
        reasoning: string;
    };
    changes: Array<{
        type: ChangeType;
        path: string;
        content?: string;
        search?: string;
        replace?: string;
    }>;
    rollbackPlan: string;
    status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
}

export interface RiskAssessment {
    proposalId: string;
    finalScore: RiskScore;
    gates: Array<{
        name: string;
        passed: boolean;
        details?: string;
    }>;
    approvalRequired: boolean;
    canAutoApply: boolean;
}

export interface OutcomeRecord {
    proposalId: string;
    timestamp: string;
    success: boolean;
    testResults?: Array<{
        testName: string;
        passed: boolean;
        output?: string;
    }>;
    rollbackPerformed: boolean;
    error?: string;
}

export interface ReflectionMetrics {
    totalReflections: number;
    totalProposals: number;
    appliedChanges: number;
    successRate: number;
    lastHeartbeat: string;
}

// ─── SOUL TYPES ─────────────────────────────────────────────────────────────

export interface EmotionalState {
    warmth: number;
    focus: number;
    calm: number;
    empowerment: number;
    conflict: number;
}

export interface SoulIdentity {
    values: string[];
    boundaries: string[];
    roles: string[];
    evolutionLog: any[];
}

export interface SoulReflection {
    id: string;
    timestamp: string;
    decision: string;
    context: string;
    emotionalState: EmotionalState;
    confidence: number;
    uncertainties?: string[];
    postDecisionReflection?: string;
}

export interface ReflectionJournalEntry {
    entryId: string;
    timestamp: string;
    issueId: string;
    patchId?: string;
    eventType: 'issue_opened' | 'hypothesis_selected' | 'patch_staged' | 'validation_passed' | 'validation_failed' | 'promotion_accepted' | 'promotion_rejected' | 'rollback_executed';
    summary: string;
    evidence: any;
    decision?: string;
    tests?: any;
    risks?: any;
    nextSteps?: string;
    tags: string[];
    confidence: number;
}

export type GoalCategory = 'stability' | 'memory' | 'routing' | 'identity' | 'performance' | 'tooling' | 'ui' | 'testing' | 'documentation';
export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';
export type GoalStatus = 'queued' | 'scheduled' | 'active' | 'analyzing' | 'blocked' | 'proposal_ready' | 'validating' | 'awaiting_review' | 'completed' | 'rejected' | 'failed';
export type GoalSource = 'user' | 'system' | 'reflection' | 'operator';

export interface SelfImprovementGoal {
    goalId: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    description: string;
    category: GoalCategory;
    priority: GoalPriority;
    status: GoalStatus;
    source: GoalSource;
    linkedIssueIds: string[];
    linkedPatchIds: string[];
    successCriteria: string[];
    notes: string;
}

export interface ReflectionDashboardState {
    totalReflections: number;
    totalProposals: number;
    appliedChanges: number;
    successRate: number;
    activeIssues: number;
    queuedGoals: number;
    activeGoals: number;
    proposalsReady: number;
    validationFailures: number;
    recentJournalEntries: number;
    recentPromotions: number;
    recentRollbacks: number;
    capabilityState: string | null;
    currentMode: string;
    pipelineActivity?: ReflectionPipelineActivity;
    schedulerState?: ReflectionSchedulerState;
}

export interface ReflectionSchedulerState {
    enabled: boolean;
    lastTickAt?: string;
    nextTickAt?: string;
    isRunning: boolean;
    activeQueueItemId?: string;
    activeRunType?: string;
    queueDepth: number;
    queuedGoals: number;
    lastRunSummary?: string;
    lastError?: string;
    consecutiveFailures: number;
    maxConcurrentJobs: number;
}

export type ReflectionPipelinePhase = 'idle' | 'queueing' | 'observing' | 'reflecting' | 'patching' | 'validating' | 'promoting' | 'journaling' | 'rolling_back' | 'failed' | 'completed';

export interface ReflectionPipelineActivity {
    isActive: boolean;
    currentPhase: ReflectionPipelinePhase;
    currentQueueItemId?: string;
    currentGoalId?: string;
    currentIssueId?: string;
    currentPatchId?: string;
    currentValidationReportId?: string;
    startedAt?: string;
    elapsedMs?: number;
    lastCompletedAt?: string;
    lastOutcome?: string;
    lastSummary?: string;
    lastError?: string;
    queueDepth: number;
    queuedGoalCount: number;
    activeGoalCount: number;
    proposalsReadyCount: number;
    validationsRunningCount: number;
    promotionsPendingCount: number;
}
