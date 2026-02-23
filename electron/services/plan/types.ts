export type GoalStatus = 'pending' | 'active' | 'completed' | 'blocked' | 'cancelled';

/**
 * A single node in the Goal Graph.
 * Decomposes high-level requests into atomic, trackable actions.
 */
export interface GoalNode {
    /** Unique identifier for the goal. */
    id: string;
    /** ID of the parent goal (null if root). */
    parentId: string | null;
    /** Human-readable title of the task. */
    title: string;
    /** Detailed description of success criteria. */
    description: string;
    /** Current state. */
    status: GoalStatus;
    /** List of child goal IDs. */
    children: string[];
    /** IDs of other goals that must be completed first. */
    dependencies: string[];
    /** Turn index when created. */
    createdIndex: number;
    /** Turn index when finished. */
    completedIndex?: number;
    /** Optional metadata (e.g., associated files, tool calls). */
    metadata?: Record<string, any>;
    /** Roleplay immersion text for Star Citizen context. */
    immersion?: string;
}

/**
 * The full state of the Agent's current objective.
 */
export interface GoalGraph {
    /** The active session this graph belongs to. */
    sessionId: string;
    /** Map of goal IDs to nodes. */
    nodes: Record<string, GoalNode>;
    /** ID of the current root goal. */
    rootGoalId: string;
    /** The ID of the currently focused goal. */
    activeGoalId: string;
    /** Total number of turns in this planning session. */
    turnCount: number;
}
