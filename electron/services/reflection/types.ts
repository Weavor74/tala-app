/**
 * Reflection Primitives
 * 
 * Core structural types for the reflection engine.
 */
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
        /** Phase 2: normalized subsystem signals that contributed to this reflection. */
        signals?: any[];
        /** Phase 2: trigger evaluation result that caused this reflection to fire. */
        triggerEval?: {
            shouldTrigger: boolean;
            triggerReason: string;
            triggeredBy?: string;
            anomalyCount: number;
            failureCount: number;
        };
    };
    observations: string[];
    metrics: {
        averageLatencyMs: number;
        errorRate: number;
    };
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
