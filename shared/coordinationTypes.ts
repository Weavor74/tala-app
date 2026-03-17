/**
 * Coordination Types — Phase 4D: Convergence & Coordination
 *
 * Canonical types for the A2UI surface coordination layer.
 * Covers policy decisions, surface lifecycle, event triggers, and the
 * UI → cognition feedback loop.
 *
 * Design rules:
 * - All types are IPC-safe (no functions, no circular refs).
 * - SurfaceDecision is the single unit of output from the policy engine.
 * - CognitiveInteractionEvent carries only structured summaries — never raw UI payloads.
 */

import type { A2UISurfaceId } from './a2uiTypes';

// ─── Surface decisions ────────────────────────────────────────────────────────

/**
 * What the policy engine decided to do with a surface on this evaluation pass.
 */
export type SurfaceAction = 'open' | 'update' | 'focus' | 'suppress';

/**
 * A single policy decision for one surface.
 * Produced by SurfacePolicyEngine for each surface that was evaluated.
 */
export interface SurfaceDecision {
    /** Surface this decision applies to. */
    surfaceId: A2UISurfaceId;
    /** What should happen to the surface. */
    action: SurfaceAction;
    /** Human-readable reason for this decision (diagnostics / telemetry). */
    reason: string;
    /** Trigger that caused this evaluation (intent-based, event-based, user). */
    triggerType: SurfaceTriggerType;
}

// ─── Policy engine inputs ─────────────────────────────────────────────────────

/**
 * What caused the policy evaluation to run.
 */
export type SurfaceTriggerType =
    | 'intent_based'
    | 'event_based'
    | 'user_request'
    | 'maintenance_event'
    | 'world_event'
    | 'cognitive_event';

/**
 * Compact maintenance summary for policy evaluation.
 * Derived from MaintenanceDiagnosticsSummary — no raw issue payloads.
 */
export interface MaintenancePolicyInput {
    hasCriticalIssues: boolean;
    hasHighIssues: boolean;
    hasPendingAutoAction: boolean;
    hasApprovalNeededAction: boolean;
    totalIssueCount: number;
    /** Whether a maintenance cycle just ran (state is freshly changed). */
    justRan?: boolean;
}

/**
 * Compact world model summary for policy evaluation.
 */
export interface WorldPolicyInput {
    hasActiveDegradation: boolean;
    inferenceReady: boolean;
    repoDetected: boolean;
    workspaceResolved: boolean;
    /** Whether the world model was just rebuilt (fresh data). */
    justRebuilt?: boolean;
}

/**
 * Compact cognitive diagnostics summary for policy evaluation.
 */
export interface CognitivePolicyInput {
    /** Classified intent class for the current turn. */
    intentClass: string;
    /** Whether this is a greeting / small-talk turn. */
    isGreeting: boolean;
    /** Number of degraded sources (missing memory, doc, astro). */
    degradedSourceCount: number;
}

/**
 * Full input packet for SurfacePolicyEngine.evaluate().
 */
export interface SurfacePolicyInput {
    /** Classified intent class. */
    intentClass: string;
    /** Whether this is a greeting/small-talk turn. */
    isGreeting: boolean;
    /** Active mode (assistant / rp / hybrid). */
    mode: string;
    /** Compact maintenance state summary. */
    maintenance?: MaintenancePolicyInput;
    /** Compact world model summary. */
    world?: WorldPolicyInput;
    /** Compact cognitive diagnostics. */
    cognitive?: CognitivePolicyInput;
    /** What triggered this evaluation. */
    triggerType: SurfaceTriggerType;
}

// ─── Surface state ────────────────────────────────────────────────────────────

/**
 * State entry tracked by SurfaceStateRegistry for one surface.
 */
export interface SurfaceStateEntry {
    /** Surface ID. */
    surfaceId: A2UISurfaceId;
    /** Whether the surface is currently open in the workspace. */
    isOpen: boolean;
    /** ISO timestamp of the last open or update. */
    lastUpdatedAt: string;
    /** Hash of the last data snapshot pushed to this surface. */
    lastDataHash: string;
    /** Whether the surface is currently focused. */
    isFocused: boolean;
    /** Number of times this surface has been opened in the session. */
    openCount: number;
    /** ISO timestamp of the last time the surface was focused. */
    lastFocusedAt?: string;
}

/**
 * Options when registering/updating a surface in the registry.
 */
export interface SurfaceStateUpdateOptions {
    dataHash?: string;
    isFocused?: boolean;
}

// ─── Cooldown state ───────────────────────────────────────────────────────────

/**
 * Per-surface cooldown tracking entry.
 */
export interface SurfaceCooldownEntry {
    surfaceId: A2UISurfaceId;
    /** ISO timestamp of the last open action (not update). */
    lastOpenedAt: string;
    /** Cooldown period in milliseconds. */
    cooldownMs: number;
}

// ─── UI → Cognition feedback ──────────────────────────────────────────────────

/**
 * A structured cognitive interaction event.
 * Captures a user's interaction with an A2UI surface in a form safe
 * for injection into short-term memory and reflection signals.
 *
 * Rules:
 * - No raw UI payloads.
 * - Only structured summary text.
 * - Bounded size (max ~200 chars in summary).
 */
export interface CognitiveInteractionEvent {
    /** ISO timestamp when the action occurred. */
    timestamp: string;
    /** The action name that was dispatched. */
    actionName: string;
    /** The surface the action came from. */
    surfaceId: A2UISurfaceId;
    /** Structured human-readable summary of what happened. */
    summary: string;
    /** Whether the action succeeded. */
    success: boolean;
}

/**
 * Result of feeding a CognitiveInteractionEvent into cognition.
 */
export interface CognitiveFeedbackResult {
    /** Whether the event was accepted into the cognition loop. */
    accepted: boolean;
    /** Why the event was rejected or accepted. */
    reason: string;
}

// ─── Coordinator diagnostics ──────────────────────────────────────────────────

/**
 * Diagnostics summary for the A2UISurfaceCoordinator.
 * IPC-safe and suitable for diagnostics surfaces.
 */
export interface CoordinatorDiagnosticsSummary {
    /** Total policy evaluations in this session. */
    policyEvaluationCount: number;
    /** Total surfaces opened by the coordinator. */
    surfacesOpened: number;
    /** Total surfaces updated by the coordinator (in-place). */
    surfacesUpdated: number;
    /** Total surfaces suppressed by policy. */
    surfacesSuppressed: number;
    /** Total UI→cognition feedback events accepted. */
    feedbackEventsAccepted: number;
    /** Total auto-triggered surface opens (from system events, not user request). */
    autoTriggeredCount: number;
    /** Current open surfaces from the state registry. */
    openSurfaces: Array<{ surfaceId: A2UISurfaceId; lastUpdatedAt: string; openCount: number }>;
}
