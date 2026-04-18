import type { TurnAuthorityEnvelope, TurnMode, MemoryWriteMode } from './turnArbitrationTypes';

export type MemoryWriteCategory =
    | 'conversation_summary'
    | 'conversation_memory'
    | 'episodic_memory'
    | 'planning_episode'
    | 'execution_episode'
    | 'recovery_episode'
    | 'goal_state';

export type MemoryWriteAuthorityDecision = 'allow' | 'deny';

export type MemoryAuthorityReasonCode =
    | 'missing_turn_context'
    | 'missing_authority_envelope'
    | 'missing_memory_write_mode'
    | 'invalid_category_for_write_mode'
    | 'durable_state_not_permitted'
    | 'goal_linkage_required'
    | 'goal_execution_mode_required'
    | 'hybrid_goal_write_not_permitted'
    | 'authority_level_insufficient'
    | 'source_not_allowed'
    | 'policy_blocked'
    | 'system_authority_required';

export type MemoryWriteSource =
    | 'agent_kernel'
    | 'planning_service'
    | 'planning_loop'
    | 'tool_execution'
    | 'workflow_handoff'
    | 'agent_handoff'
    | 'memory_service'
    | 'reflection_service'
    | 'system';

export interface MemoryWriteRequest {
    writeId: string;
    category: MemoryWriteCategory;
    source: MemoryWriteSource;
    turnId?: string;
    conversationId?: string;
    goalId?: string;
    episodeType?: string;
    payload: Record<string, unknown>;
}

export interface MemoryAuthorityContext {
    turnId?: string;
    conversationId?: string;
    goalId?: string;
    turnMode?: TurnMode;
    memoryWriteMode?: MemoryWriteMode;
    authorityEnvelope?: TurnAuthorityEnvelope;
    systemAuthority?: boolean;
}

export interface MemoryAuthorityDecision {
    requestId: string;
    decision: MemoryWriteAuthorityDecision;
    category: MemoryWriteCategory;
    reasonCodes: MemoryAuthorityReasonCode[];
    requiresGoalId: boolean;
    requiresTurnContext: boolean;
    requiresDurableStateAuthority: boolean;
    normalizedWriteMode?: MemoryWriteMode;
}

export interface MemoryAuthorityDiagnosticsView {
    lastDecision?: MemoryAuthorityDecision;
    lastDeniedCategory?: MemoryWriteCategory;
    lastDeniedReasonCodes: MemoryAuthorityReasonCode[];
    allowCount: number;
    denyCount: number;
    countsByCategory: Partial<Record<MemoryWriteCategory, number>>;
    countsByWriteMode: Partial<Record<MemoryWriteMode | 'unknown', number>>;
    lastUpdated: string;
}

