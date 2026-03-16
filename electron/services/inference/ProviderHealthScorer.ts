/**
 * ProviderHealthScorer — Provider Auto-Recovery System
 *
 * Phase 2B Objective B
 *
 * Tracks per-provider health scores based on failure streaks, timeouts, and
 * fallback events. Implements automatic demotion and conservative recovery:
 *
 * - failureStreak >= DEMOTION_THRESHOLD → mark provider degraded, lower priority
 * - failureStreak >= SUPPRESSION_THRESHOLD → suppress from auto-selection
 * - Suppression is always time-bounded (SUPPRESSION_WINDOW_MS)
 * - Recovery occurs automatically when provider succeeds again
 * - All scoring changes emit reflection signals and telemetry
 *
 * Design rules:
 * - Never disables a provider permanently.
 * - Recovery must be observable in telemetry.
 * - Scoring decisions must be conservative to avoid thrashing.
 */

import { telemetry } from '../TelemetryService';
import { ReflectionEngine } from '../reflection/ReflectionEngine';
import type { ProviderHealthScore } from '../../../shared/runtimeDiagnosticsTypes';

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Failure streak at which provider priority is lowered. */
const DEMOTION_THRESHOLD = 3;
/** Failure streak at which provider is suppressed from auto-selection. */
const SUPPRESSION_THRESHOLD = 5;
/** How long a suppression lasts before automatic retry (ms). */
const SUPPRESSION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/** Priority penalty applied during demotion. */
const DEMOTION_PRIORITY_PENALTY = 10;
/** Time window for instability pattern detection (ms). */
const INSTABILITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Number of restarts within the instability window that triggers a signal. */
const INSTABILITY_RESTART_THRESHOLD = 3;

// ─── ProviderHealthScorer ─────────────────────────────────────────────────────

export class ProviderHealthScorer {
    private scores: Map<string, ProviderHealthScore> = new Map();
    /** Restart timestamps per provider within the instability window. */
    private restartHistory: Map<string, number[]> = new Map();

    // ─── Score initialization ──────────────────────────────────────────────────

    /**
     * Ensures a score entry exists for the given provider.
     */
    public ensureScore(providerId: string, basePriority = 1): ProviderHealthScore {
        if (!this.scores.has(providerId)) {
            this.scores.set(providerId, {
                providerId,
                failureStreak: 0,
                timeoutCount: 0,
                fallbackCount: 0,
                suppressed: false,
                effectivePriority: basePriority,
            });
        }
        return this.scores.get(providerId)!;
    }

    // ─── Event recording ───────────────────────────────────────────────────────

    /**
     * Records a successful inference on this provider.
     * Resets failure streak and restores priority if previously demoted.
     */
    public recordSuccess(providerId: string, basePriority = 1): void {
        const score = this.ensureScore(providerId, basePriority);
        const wasSupressed = score.suppressed;
        const wasDemoted = score.effectivePriority > basePriority;
        const now = new Date().toISOString();

        score.lastSuccess = now;
        score.failureStreak = 0;
        score.suppressed = false;
        score.suppressedUntil = undefined;
        score.effectivePriority = basePriority;

        if (wasSupressed || wasDemoted) {
            telemetry.operational(
                'inference',
                'provider_health_recovered',
                'info',
                'ProviderHealthScorer',
                `Provider ${providerId} recovered — priority restored`,
                'success',
                {
                    payload: {
                        providerId,
                        entityType: 'provider',
                        priorState: wasSupressed ? 'suppressed' : 'demoted',
                        newState: 'recovered',
                        reason: 'Successful inference after failure streak',
                        timestamp: now,
                    },
                }
            );

            ReflectionEngine.reportSignal({
                timestamp: now,
                subsystem: 'inference',
                category: 'provider_instability_pattern',
                description: `Provider ${providerId} recovered from ${wasSupressed ? 'suppression' : 'demotion'} after successful inference`,
                context: { providerId, recovered: true },
            });
        }
    }

    /**
     * Records an inference failure on this provider.
     * Applies demotion/suppression logic based on failure streak.
     */
    public recordFailure(providerId: string, basePriority = 1, reason?: string): void {
        const score = this.ensureScore(providerId, basePriority);
        const now = new Date().toISOString();
        score.lastFailure = now;
        score.failureStreak++;

        if (score.failureStreak === DEMOTION_THRESHOLD) {
            score.effectivePriority = basePriority + DEMOTION_PRIORITY_PENALTY;
            telemetry.operational(
                'inference',
                'provider_health_demoted',
                'warn',
                'ProviderHealthScorer',
                `Provider ${providerId} demoted — failure streak ${score.failureStreak}`,
                'failure',
                {
                    payload: {
                        providerId,
                        entityType: 'provider',
                        priorState: 'ready',
                        newState: 'degraded',
                        reason: reason ?? `Failure streak reached ${DEMOTION_THRESHOLD}`,
                        timestamp: now,
                        failureStreak: score.failureStreak,
                    },
                }
            );
        }

        if (score.failureStreak >= SUPPRESSION_THRESHOLD && !score.suppressed) {
            score.suppressed = true;
            score.suppressedUntil = new Date(Date.now() + SUPPRESSION_WINDOW_MS).toISOString();

            telemetry.operational(
                'inference',
                'provider_health_demoted',
                'error',
                'ProviderHealthScorer',
                `Provider ${providerId} suppressed — failure streak ${score.failureStreak}`,
                'failure',
                {
                    payload: {
                        providerId,
                        entityType: 'provider',
                        priorState: 'degraded',
                        newState: 'suppressed',
                        reason: reason ?? `Failure streak reached ${SUPPRESSION_THRESHOLD}`,
                        timestamp: now,
                        failureStreak: score.failureStreak,
                        suppressedUntil: score.suppressedUntil,
                    },
                }
            );

            ReflectionEngine.reportThresholdedSignal(
                {
                    timestamp: now,
                    subsystem: 'inference',
                    category: 'provider_instability_pattern',
                    description: `Provider ${providerId} suppressed after ${score.failureStreak} consecutive failures`,
                    context: { providerId, failureStreak: score.failureStreak, suppressedUntil: score.suppressedUntil },
                },
                score.failureStreak,
                SUPPRESSION_THRESHOLD,
            );
        }
    }

    /**
     * Records an inference timeout on this provider.
     */
    public recordTimeout(providerId: string, basePriority = 1): void {
        const score = this.ensureScore(providerId, basePriority);
        score.timeoutCount++;
        this.recordFailure(providerId, basePriority, 'Inference timeout');
    }

    /**
     * Records a fallback event (provider was bypassed in favor of another).
     */
    public recordFallback(providerId: string, basePriority = 1): void {
        const score = this.ensureScore(providerId, basePriority);
        score.fallbackCount++;
    }

    /**
     * Records a manual restart action for instability detection.
     * Emits provider_instability_pattern if restart rate exceeds threshold.
     */
    public recordRestart(providerId: string): void {
        const now = Date.now();
        if (!this.restartHistory.has(providerId)) {
            this.restartHistory.set(providerId, []);
        }
        const history = this.restartHistory.get(providerId)!;
        history.push(now);

        // Prune events outside the instability window
        const cutoff = now - INSTABILITY_WINDOW_MS;
        const recent = history.filter(t => t >= cutoff);
        this.restartHistory.set(providerId, recent);

        if (recent.length >= INSTABILITY_RESTART_THRESHOLD) {
            ReflectionEngine.reportThresholdedSignal(
                {
                    timestamp: new Date().toISOString(),
                    subsystem: 'inference',
                    category: 'repeated_provider_restart',
                    description: `Provider ${providerId} restarted ${recent.length} times within ${INSTABILITY_WINDOW_MS / 60000} minutes`,
                    context: { providerId, restartCount: recent.length, windowMs: INSTABILITY_WINDOW_MS },
                },
                recent.length,
                INSTABILITY_RESTART_THRESHOLD,
            );
        }
    }

    // ─── Suppression check ─────────────────────────────────────────────────────

    /**
     * Returns true if the provider is currently suppressed from auto-selection.
     * Automatically lifts time-expired suppressions.
     */
    public isSuppressed(providerId: string): boolean {
        const score = this.scores.get(providerId);
        if (!score || !score.suppressed) return false;

        // Lift expired suppression
        if (score.suppressedUntil && new Date().toISOString() > score.suppressedUntil) {
            score.suppressed = false;
            score.suppressedUntil = undefined;
            score.effectivePriority = score.effectivePriority; // Retain until next success
            return false;
        }

        return true;
    }

    // ─── Read API ──────────────────────────────────────────────────────────────

    /** Returns all current health scores as an array. */
    public getAllScores(): ProviderHealthScore[] {
        // Refresh suppression state before returning
        for (const id of this.scores.keys()) {
            this.isSuppressed(id);
        }
        return Array.from(this.scores.values()).map(s => ({ ...s }));
    }

    /** Returns the health score for a single provider (or undefined). */
    public getScore(providerId: string): ProviderHealthScore | undefined {
        this.isSuppressed(providerId); // Refresh suppression
        const s = this.scores.get(providerId);
        return s ? { ...s } : undefined;
    }

    /** Returns IDs of all currently suppressed providers. */
    public getSuppressedProviderIds(): string[] {
        return Array.from(this.scores.keys()).filter(id => this.isSuppressed(id));
    }

    /** Returns the effective selection priority for a provider. */
    public getEffectivePriority(providerId: string, basePriority = 1): number {
        const score = this.scores.get(providerId);
        return score?.effectivePriority ?? basePriority;
    }

    /**
     * Resets the health score for a provider (e.g., after a manual restart).
     * Does not restore priority — the next success does that.
     */
    public resetScore(providerId: string): void {
        const score = this.scores.get(providerId);
        if (score) {
            score.failureStreak = 0;
            score.suppressed = false;
            score.suppressedUntil = undefined;
        }
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

export const providerHealthScorer = new ProviderHealthScorer();
