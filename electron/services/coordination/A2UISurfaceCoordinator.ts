/**
 * A2UISurfaceCoordinator — Phase 4D: Convergence & Coordination
 *
 * Central orchestrator between the cognition/world/maintenance systems and
 * the A2UI workspace surfaces. Receives policy decisions and routes them to
 * the correct surface via A2UIWorkspaceRouter.
 *
 * Responsibilities:
 * 1. Accept SurfacePolicyInput from PreInferenceContextOrchestrator, event
 *    hooks, or user requests.
 * 2. Delegate policy evaluation to SurfacePolicyEngine.
 * 3. Execute surface decisions: open / update / focus / suppress.
 * 4. Update SurfaceStateRegistry after each action.
 * 5. Emit telemetry for every decision and action.
 * 6. Suppress no-op updates when data has not changed.
 * 7. Emit lightweight chat notices (not surface content) when surfaces open.
 *
 * Anti-noise rules:
 * - Cooldowns prevent repeated opens (delegated to registry).
 * - Data-hash comparison skips no-op updates.
 * - Policy suppression blocks irrelevant surfaces.
 */

import type { BrowserWindow } from 'electron';
import type { SurfaceDecision, SurfacePolicyInput, CoordinatorDiagnosticsSummary } from '../../../shared/coordinationTypes';
import type { A2UISurfaceId } from '../../../shared/a2uiTypes';
import { SurfacePolicyEngine } from './SurfacePolicyEngine';
import { SurfaceStateRegistry } from './SurfaceStateRegistry';
import type { A2UIWorkspaceRouter } from '../A2UIWorkspaceRouter';
import { telemetry } from '../TelemetryService';

// ─── Chat notice messages ─────────────────────────────────────────────────────

const SURFACE_NOTICE: Record<A2UISurfaceId, string> = {
    cognition: 'Opened cognition panel',
    world: 'Opened world view',
    maintenance: 'Opened maintenance panel',
};

const SURFACE_UPDATE_NOTICE: Record<A2UISurfaceId, string> = {
    cognition: 'Updated cognition panel',
    world: 'Updated world view',
    maintenance: 'Updated maintenance panel',
};

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface A2UISurfaceCoordinatorDeps {
    policyEngine: SurfacePolicyEngine;
    registry: SurfaceStateRegistry;
    router: A2UIWorkspaceRouter;
    /** Optional: BrowserWindow getter to emit chat notices. */
    getMainWindow?: () => BrowserWindow | null;
}

// ─── A2UISurfaceCoordinator ───────────────────────────────────────────────────

/**
 * A2UISurfaceCoordinator
 *
 * The single coordination point for A2UI workspace surfaces.
 * Drives surface lifecycle through policy decisions and keeps
 * the SurfaceStateRegistry in sync.
 */
export class A2UISurfaceCoordinator {
    private readonly _deps: A2UISurfaceCoordinatorDeps;

    private _policyEvaluationCount = 0;
    private _surfacesOpened = 0;
    private _surfacesUpdated = 0;
    private _surfacesSuppressed = 0;
    private _feedbackEventsAccepted = 0;
    private _autoTriggeredCount = 0;

    constructor(deps: A2UISurfaceCoordinatorDeps) {
        this._deps = deps;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Main coordination entry point.
     *
     * Evaluates policy for the given input, then executes the resulting
     * surface decisions. Returns the list of decisions that were acted upon.
     */
    public async coordinate(input: SurfacePolicyInput): Promise<SurfaceDecision[]> {
        this._policyEvaluationCount++;

        telemetry.event('surface_policy_evaluated', {
            surfaceId: undefined,
            reason: `intent=${input.intentClass} mode=${input.mode} trigger=${input.triggerType}`,
        });

        const decisions = this._deps.policyEngine.evaluate(input);

        // Track auto-triggered events
        const isAuto = input.triggerType === 'maintenance_event'
            || input.triggerType === 'world_event'
            || input.triggerType === 'event_based';

        for (const decision of decisions) {
            await this._executeDecision(decision);
            if (isAuto && decision.action !== 'suppress') {
                this._autoTriggeredCount++;
                telemetry.event('surface_auto_triggered', {
                    surfaceId: decision.surfaceId,
                    reason: decision.reason,
                });
            }
        }

        return decisions;
    }

    /**
     * Handles a user-requested surface open.
     * Bypasses cooldown (user intent is always honored) but still
     * uses policy for mode/greeting suppression.
     */
    public async openForUser(surfaceId: A2UISurfaceId): Promise<void> {
        const input: SurfacePolicyInput = {
            intentClass: 'user_request',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'user_request',
        };

        telemetry.event('surface_policy_evaluated', {
            surfaceId,
            reason: `user_request for ${surfaceId}`,
        });

        const decisions = this._deps.policyEngine.evaluate(input);
        const decision = decisions.find(d => d.surfaceId === surfaceId && d.action !== 'suppress');

        if (decision) {
            await this._executeDecision({ ...decision, action: 'open' });
            telemetry.event('surface_user_triggered', {
                surfaceId,
                reason: 'user_request',
            });
        } else {
            // Policy suppressed — still open for user (user intent wins)
            await this._deps.router.openSurface(surfaceId, { focus: true });
            this._deps.registry.markOpened(surfaceId, { isFocused: true });
            this._surfacesOpened++;
            telemetry.event('surface_user_triggered', {
                surfaceId,
                reason: 'user_request_policy_override',
            });
        }
    }

    /**
     * Returns the coordinator diagnostics summary.
     */
    public getDiagnosticsSummary(): CoordinatorDiagnosticsSummary {
        return {
            policyEvaluationCount: this._policyEvaluationCount,
            surfacesOpened: this._surfacesOpened,
            surfacesUpdated: this._surfacesUpdated,
            surfacesSuppressed: this._surfacesSuppressed,
            feedbackEventsAccepted: this._feedbackEventsAccepted,
            autoTriggeredCount: this._autoTriggeredCount,
            openSurfaces: this._deps.registry.getOpenSurfaces().map(e => ({
                surfaceId: e.surfaceId,
                lastUpdatedAt: e.lastUpdatedAt,
                openCount: e.openCount,
            })),
        };
    }

    /**
     * Records that a CognitiveInteractionEvent was accepted into cognition.
     * Called by A2UIActionBridge after feeding an event into short-term memory.
     */
    public recordFeedbackAccepted(): void {
        this._feedbackEventsAccepted++;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async _executeDecision(decision: SurfaceDecision): Promise<void> {
        const { surfaceId, action, reason, triggerType } = decision;
        const registry = this._deps.registry;
        const router = this._deps.router;

        switch (action) {
            case 'suppress': {
                this._surfacesSuppressed++;
                telemetry.event('surface_decision_suppress', {
                    surfaceId,
                    reason,
                });
                return;
            }

            case 'open': {
                if (registry.isOnCooldown(surfaceId) && registry.isOpen(surfaceId)) {
                    // Within cooldown + already open: downgrade to update
                    await this._updateSurface(surfaceId, reason, triggerType === 'user_request' ? 'user_request' : 'event_based');
                    return;
                }

                telemetry.event('surface_decision_open', { surfaceId, reason });
                const payload = await router.openSurface(surfaceId, { focus: false });
                if (payload) {
                    registry.markOpened(surfaceId, { dataHash: _hashPayload(payload) });
                    this._surfacesOpened++;
                    this._emitChatNotice(surfaceId, 'open');
                }
                return;
            }

            case 'update': {
                await this._updateSurface(surfaceId, reason, triggerType);
                return;
            }

            case 'focus': {
                telemetry.event('surface_focus_requested', { surfaceId, reason });
                const payload = await router.openSurface(surfaceId, { focus: true });
                if (payload) {
                    registry.markUpdated(surfaceId, { dataHash: _hashPayload(payload), isFocused: true });
                    this._surfacesUpdated++;
                }
                return;
            }
        }
    }

    private async _updateSurface(
        surfaceId: A2UISurfaceId,
        reason: string,
        triggerType: string,
    ): Promise<void> {
        const registry = this._deps.registry;
        const router = this._deps.router;

        // Assemble payload to check hash before sending
        const payload = await router.openSurface(surfaceId, { focus: false });
        if (!payload) return;

        const newHash = _hashPayload(payload);
        const prevHash = registry.getLastDataHash(surfaceId);

        if (newHash === prevHash && registry.isOpen(surfaceId)) {
            // Data hasn't changed — skip the update
            telemetry.event('surface_update_skipped', {
                surfaceId,
                reason: 'no_change',
            });
            return;
        }

        telemetry.event('surface_decision_update', { surfaceId, reason });
        registry.markUpdated(surfaceId, { dataHash: newHash });
        this._surfacesUpdated++;
        if (!registry.isOpen(surfaceId)) {
            this._emitChatNotice(surfaceId, 'open');
        } else {
            this._emitChatNotice(surfaceId, 'update');
        }
    }

    /**
     * Emits a lightweight chat notice via the agent-event channel.
     * Chat receives only a brief notice — never surface content.
     */
    private _emitChatNotice(surfaceId: A2UISurfaceId, type: 'open' | 'update'): void {
        const win = this._deps.getMainWindow?.();
        if (!win || win.isDestroyed()) return;

        const message = type === 'open'
            ? SURFACE_NOTICE[surfaceId]
            : SURFACE_UPDATE_NOTICE[surfaceId];

        win.webContents.send('agent-event', {
            type: 'a2ui-chat-notice',
            data: { surfaceId, message },
        });
    }
}

// ─── Payload hashing ──────────────────────────────────────────────────────────

/**
 * Produces a lightweight hash of a surface payload for change detection.
 * Uses the assembledAt timestamp and component count as a proxy.
 */
function _hashPayload(payload: { assembledAt: string; components: unknown[] }): string {
    return `${payload.assembledAt}:${payload.components.length}`;
}
