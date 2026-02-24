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

