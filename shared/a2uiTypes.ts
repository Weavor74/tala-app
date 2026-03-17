/**
 * A2UI Workspace Surface Types — Phase 4C: Dynamic UI Workspace Surfaces
 *
 * Defines the canonical type model for Tala's A2UI workspace surface system.
 * A2UI surfaces render in the document/editor pane (not in chat).
 * Chat receives only lightweight textual notices when surfaces open.
 *
 * Design rules:
 * - Surfaces are keyed by stable surface ID (cognition, world, maintenance).
 * - Surface payloads are serializable over IPC (no circular refs, no functions).
 * - Actions are allowlisted and validated before execution.
 * - No raw prompts, no raw memory contents, no unsafe data in surface payloads.
 */

// ─── Surface identity ─────────────────────────────────────────────────────────

/**
 * Canonical surface identifiers for Tala's A2UI workspace surfaces.
 * Each surface ID maps to a stable tab in the document/editor pane.
 */
export type A2UISurfaceId = 'cognition' | 'world' | 'maintenance';

/**
 * Display metadata for each known surface type.
 */
export const A2UI_SURFACE_DISPLAY: Record<A2UISurfaceId, { title: string; description: string }> = {
    cognition: {
        title: 'Cognition',
        description: "Tala's current cognitive inputs and reasoning state",
    },
    world: {
        title: 'World Model',
        description: "Tala's structured understanding of the workspace environment",
    },
    maintenance: {
        title: 'Maintenance',
        description: 'Active maintenance issues, recommendations, and safe actions',
    },
};

// ─── A2UI component tree ──────────────────────────────────────────────────────

/**
 * A single node in the A2UI component tree.
 * Maps to registered component types in BasicComponents.tsx.
 */
export interface A2UINode {
    /** Unique identifier for this node within the surface. */
    id: string;
    /** Component type string (mapped to React component in catalog). */
    type: string;
    /** Props passed to the React component. */
    props?: Record<string, unknown>;
    /** Recursive children. */
    children?: A2UINode[];
}

// ─── Surface payload ──────────────────────────────────────────────────────────

/**
 * Normalized A2UI surface payload — sent from main process to renderer.
 * Carries the component tree for a named surface plus routing metadata.
 */
export interface A2UISurfacePayload {
    /** Target surface ID. */
    surfaceId: A2UISurfaceId;
    /** Human-readable title for the workspace tab. */
    title: string;
    /** The A2UI component tree to render in the document/editor pane. */
    components: A2UINode[];
    /** ISO 8601 timestamp when this surface payload was assembled. */
    assembledAt: string;
    /**
     * Data source description for audit/diagnostics.
     * e.g. 'cognition:diagnostics_snapshot', 'world:world_model_assembler'
     */
    dataSource: string;
    /** Stable tab ID used to de-duplicate tabs in the workspace. */
    tabId: string;
    /**
     * Whether this surface should be focused after open.
     * Defaults to true for user-initiated opens; may be false for background refreshes.
     */
    focus?: boolean;
}

// ─── Surface open request ─────────────────────────────────────────────────────

/**
 * Request to open or update a named A2UI surface.
 * Sent from renderer to main, or generated internally by main-side services.
 */
export interface A2UISurfaceOpenRequest {
    /** Surface to open. */
    surfaceId: A2UISurfaceId;
    /** Whether to focus the tab after opening. Defaults to true. */
    focus?: boolean;
}

// ─── Action bridge ────────────────────────────────────────────────────────────

/**
 * Allowlisted A2UI action names.
 * Only these action names may be dispatched from the renderer.
 */
export type A2UIActionName =
    | 'open_cognition_surface'
    | 'open_world_surface'
    | 'open_maintenance_surface'
    | 'refresh_cognition'
    | 'refresh_world'
    | 'refresh_maintenance'
    | 'run_maintenance_check'
    | 'switch_maintenance_mode'
    | 'restart_provider'
    | 'restart_mcp_service';

/**
 * A dispatched A2UI action from the renderer.
 */
export interface A2UIActionDispatch {
    /** Surface the action originated from. */
    surfaceId: A2UISurfaceId;
    /** The allowlisted action name. */
    actionName: A2UIActionName;
    /** Bounded action payload (validated before execution). */
    payload?: Record<string, unknown>;
}

/**
 * Result of an A2UI action dispatch.
 */
export interface A2UIActionResult {
    /** Whether the action executed successfully. */
    success: boolean;
    /** Human-readable outcome message. */
    message: string;
    /** Error detail if the action failed (no sensitive data). */
    error?: string;
    /** Optional updated surface payload to push to the renderer after action. */
    updatedSurface?: A2UISurfacePayload;
}

// ─── Surface registry state ───────────────────────────────────────────────────

/**
 * Registry entry for a currently-open A2UI surface.
 * Used by diagnostics to answer "what surfaces are open".
 */
export interface A2UISurfaceRegistryEntry {
    /** Surface ID. */
    surfaceId: A2UISurfaceId;
    /** Stable tab ID. */
    tabId: string;
    /** ISO 8601 timestamp when the surface was last opened or updated. */
    lastUpdatedAt: string;
    /** Data source used for the most recent surface assembly. */
    dataSource: string;
}

/**
 * A2UI diagnostics summary — safe to expose via IPC.
 */
export interface A2UIDiagnosticsSummary {
    /** Currently registered (open) surfaces. */
    openSurfaces: A2UISurfaceRegistryEntry[];
    /** Count of A2UI actions dispatched in the current session. */
    actionDispatchCount: number;
    /** Count of A2UI surface opens/updates in the current session. */
    surfaceUpdateCount: number;
    /** Count of A2UI surface failures in the current session. */
    surfaceFailureCount: number;
    /** Count of A2UI action failures in the current session. */
    actionFailureCount: number;
}
