/**
 * SurfacePolicyEngine — Phase 4D: Convergence & Coordination
 *
 * The single authority that decides when A2UI surfaces should open, update,
 * focus, or stay suppressed.
 *
 * Evaluation is deterministic: given the same inputs the same decisions are
 * produced. All decisions include a human-readable `reason` field for
 * diagnostics / telemetry.
 *
 * Rules:
 *   Intent-based:
 *     - technical / coding   → cognition surface allowed
 *     - repo / workspace      → world surface allowed
 *     - troubleshooting       → maintenance surface allowed
 *
 *   Mode-based:
 *     - RP                    → suppress all surfaces
 *     - greeting / small-talk → suppress all surfaces
 *     - assistant / hybrid    → allow based on intent
 *
 *   Event-based (non-turn triggers):
 *     - degraded provider     → open/update maintenance surface
 *     - repo change           → update world surface
 *     - repeated failures     → focus maintenance surface
 *
 *   Anti-noise:
 *     - cooldown windows prevent repeated opens
 *     - duplicate tab suppression (checked via SurfaceStateRegistry)
 *     - no surfaces for irrelevant turns
 */

import type {
    SurfaceDecision,
    SurfacePolicyInput,
    SurfaceAction,
    SurfaceTriggerType,
} from '../../../shared/coordinationTypes';
import type { A2UISurfaceId } from '../../../shared/a2uiTypes';
import type { SurfaceStateRegistry } from './SurfaceStateRegistry';

// ─── Intent class → surface mappings ─────────────────────────────────────────

const INTENT_SURFACE_MAP: Record<string, A2UISurfaceId | undefined> = {
    technical: 'cognition',
    coding: 'cognition',
    task: 'cognition',
    troubleshooting: 'maintenance',
    repo: 'world',
    workspace: 'world',
    diagnostic: 'maintenance',
};

// ─── Mode suppression ─────────────────────────────────────────────────────────

const SUPPRESSED_MODES = new Set(['rp']);

// ─── SurfacePolicyEngine ──────────────────────────────────────────────────────

/**
 * SurfacePolicyEngine
 *
 * Evaluates policy inputs and returns an ordered list of SurfaceDecisions.
 * The caller (A2UISurfaceCoordinator) acts on those decisions.
 */
export class SurfacePolicyEngine {
    private readonly _registry: SurfaceStateRegistry;

    constructor(registry: SurfaceStateRegistry) {
        this._registry = registry;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Evaluates the current policy inputs and returns surface decisions.
     * Each decision indicates what should happen to one surface.
     *
     * @returns Array of SurfaceDecisions, one per surface that warrants action.
     *          Surfaces that should stay silent are omitted (not listed as suppress).
     */
    public evaluate(input: SurfacePolicyInput): SurfaceDecision[] {
        const decisions: SurfaceDecision[] = [];

        // ── 1. Global suppression: RP mode and greetings ──────────────────────
        if (SUPPRESSED_MODES.has(input.mode)) {
            return this._suppressAll(input.triggerType, `RP mode suppresses all surfaces`);
        }
        if (input.isGreeting) {
            return this._suppressAll(input.triggerType, `Greeting/small-talk turn suppresses all surfaces`);
        }

        // ── 2. Maintenance-event trigger ──────────────────────────────────────
        if (input.triggerType === 'maintenance_event' || input.triggerType === 'event_based') {
            const maint = input.maintenance;
            if (maint) {
                if (maint.hasCriticalIssues || maint.hasHighIssues) {
                    decisions.push(this._decide(
                        'maintenance',
                        this._openOrUpdate('maintenance'),
                        maint.hasCriticalIssues ? 'Critical maintenance issues detected' : 'High maintenance issues detected',
                        input.triggerType,
                    ));
                }
                if (maint.hasPendingAutoAction || maint.hasApprovalNeededAction) {
                    decisions.push(this._decide(
                        'maintenance',
                        'focus',
                        'Maintenance action requires attention',
                        input.triggerType,
                    ));
                }
            }
        }

        // ── 3. World-event trigger ────────────────────────────────────────────
        if (input.triggerType === 'world_event') {
            decisions.push(this._decide(
                'world',
                this._openOrUpdate('world'),
                'World model was rebuilt',
                input.triggerType,
            ));
        }

        // ── 4. Cognitive / intent-based trigger ───────────────────────────────
        if (input.triggerType === 'intent_based' || input.triggerType === 'cognitive_event' || input.triggerType === 'user_request') {
            const mappedSurface = INTENT_SURFACE_MAP[input.intentClass];
            if (mappedSurface) {
                // Check cooldown — skip open if within cooldown
                const onCooldown = this._registry.isOnCooldown(mappedSurface);
                if (onCooldown && this._registry.isOpen(mappedSurface)) {
                    decisions.push(this._decide(
                        mappedSurface,
                        'update',
                        `Intent '${input.intentClass}' matches ${mappedSurface} surface (in-place update, cooldown active)`,
                        input.triggerType,
                    ));
                } else if (!onCooldown) {
                    decisions.push(this._decide(
                        mappedSurface,
                        this._openOrUpdate(mappedSurface),
                        `Intent '${input.intentClass}' maps to ${mappedSurface} surface`,
                        input.triggerType,
                    ));
                }
            }

            // Degraded world signals → also show maintenance if troubleshooting
            if (input.world?.hasActiveDegradation && input.intentClass === 'troubleshooting') {
                if (!decisions.some(d => d.surfaceId === 'maintenance')) {
                    decisions.push(this._decide(
                        'maintenance',
                        this._openOrUpdate('maintenance'),
                        'Active degradation detected during troubleshooting intent',
                        input.triggerType,
                    ));
                }
            }
        }

        return decisions;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _decide(
        surfaceId: A2UISurfaceId,
        action: SurfaceAction,
        reason: string,
        triggerType: SurfaceTriggerType,
    ): SurfaceDecision {
        return { surfaceId, action, reason, triggerType };
    }

    private _openOrUpdate(surfaceId: A2UISurfaceId): SurfaceAction {
        return this._registry.isOpen(surfaceId) ? 'update' : 'open';
    }

    private _suppressAll(triggerType: SurfaceTriggerType, reason: string): SurfaceDecision[] {
        const surfaces: A2UISurfaceId[] = ['cognition', 'world', 'maintenance'];
        return surfaces.map(surfaceId => this._decide(surfaceId, 'suppress', reason, triggerType));
    }
}
