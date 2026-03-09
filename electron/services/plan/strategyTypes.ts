/**
 * Strategic Planning Type Definitions
 * 
 * Defines the structures used by TALA's Navigator to simulate and evaluate
 * different paths for achieving a high-level goal.
 */
/**
 * Represents a single strategic path for achieving a goal.
 */
export interface Strategy {
    /** Unique identifier for this path. */
    id: string;
    /** Human-readable name (e.g., "Surgical Refactor", "Clean Rebuild", "Experimental Shortcut"). */
    name: string;
    /** Roleplay description for the Star Citizen companion context (e.g., "Calculating a low-fuel trajectory through the asteroid field"). */
    immersion: string;
    /** Technical explanation of why this path was chosen. */
    rationale: string;
    /** High-level steps involved in this strategy. */
    steps: string[];
    /** Estimated resource cost (1-10 scale). In-universe: "Fuel Consumption". */
    estimatedCost: number;
    /** Estimated risk level (1-10 scale). In-universe: "Hull Integrity Risk". */
    riskScore: number;
    /** The actual system tokens estimated for this path. */
    tokenEstimate: number;
}

/**
 * Results of a strategy simulation.
 */
export interface StrategicSimulation {
    /** The goal ID being simulated. */
    goalId: string;
    /** Competing paths found by the engine. */
    paths: Strategy[];
    /** The index of the path recommended by the Navigator. */
    recommendedIndex: number;
    /** Timestamp of simulation. */
    timestamp: string;
}
