/**
 * turnArbitrationTypes.ts
 *
 * Canonical turn-mode arbitration contracts.
 * AgentKernel is the single authority that produces these records.
 */

export type TurnMode =
    | 'conversational'
    | 'hybrid'
    | 'goal_execution';

export type TurnIntentStrength = 'none' | 'weak' | 'strong';

export type TurnAuthorityLevel =
    | 'none'
    | 'lightweight'
    | 'full_authority';

export type TurnArbitrationSource =
    | 'operator_override'
    | 'continuity'
    | 'rule_based'
    | 'policy';

export interface AgentTurnRequest {
    turnId: string;
    conversationId: string;
    userText: string;
    attachments?: unknown[];
    workspaceContext?: Record<string, unknown>;
    activeGoalId?: string;
    operatorMode?: 'chat' | 'goal' | 'auto';
    requestedSurface?: string;
}

export interface TurnIntentProfile {
    conversationalWeight: number;
    hybridWeight: number;
    goalExecutionWeight: number;
    hasExplicitGoalLanguage: boolean;
    hasExecutionVerb: boolean;
    referencesActiveWork: boolean;
    likelyNeedsMultiStepExecution: boolean;
    likelyNeedsOnlyExplanation: boolean;
    containsDirectQuestion: boolean;
    containsBuildOrFixRequest: boolean;
    reasonCodes: string[];
}

export interface TurnArbitrationDecision {
    turnId: string;
    mode: TurnMode;
    source: TurnArbitrationSource;
    confidence: number;
    reasonCodes: string[];
    goalIntent: TurnIntentStrength;
    shouldCreateGoal: boolean;
    shouldResumeGoal: boolean;
    activeGoalId?: string;
    requiresPlan: boolean;
    requiresExecutionLoop: boolean;
    authorityLevel: TurnAuthorityLevel;
    memoryWriteMode: 'conversation_only' | 'episodic' | 'goal_episode';
}

export interface TurnAuthorityEnvelope {
    turnId: string;
    mode: TurnMode;
    authorityLevel: TurnAuthorityLevel;
    workflowAuthority: boolean;
    canCreateDurableState: boolean;
    canReplan: boolean;
}

export interface KernelTurnDiagnosticsView {
    turnId: string;
    mode: TurnMode;
    arbitrationSource: TurnArbitrationSource;
    confidence: number;
    reasonCodes: string[];
    planningInvoked: boolean;
    executionInvoked: boolean;
    authorityLevel: TurnAuthorityLevel;
    activeGoalId?: string;
    createdGoalId?: string;
    updatedAt: string;
}

