/**
 * PlanRunRegistry.ts — Phase 2 Run Control
 *
 * Enforces three overlapping safety mechanisms for the safe-change
 * planning pipeline:
 *
 * 1. Active-run lock
 *    Only one planning run may be active per subsystem at a time.
 *    A second attempt while a run is active receives 'deduped' status
 *    and a reference to the existing run.
 *
 * 2. Trigger deduplication
 *    Before starting a run, a fingerprint is computed from:
 *      subsystemId + issueType + normalizedTarget + timeBucket (hour)
 *    If a matching active or recently-completed run is found, the new
 *    request is attached to it rather than spawning a duplicate.
 *
 * 3. Subsystem cooldown
 *    After a run completes, the subsystem enters a cooldown window
 *    (default: 10–30 minutes depending on severity) during which new
 *    runs are rejected with 'cooldown_blocked' status.
 *    Critical-severity triggers and manual triggers bypass cooldown.
 */

import type {
    PlanRun,
    PlanRunStatus,
    TriggerFingerprint,
    DedupCheckResult,
    SubsystemCooldownState,
    PlanTriggerInput,
} from '../../../shared/reflectionPlanTypes';
import { telemetry } from '../TelemetryService';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Cooldown duration per severity level (milliseconds). */
const COOLDOWN_MS: Record<string, number> = {
    low: 30 * 60 * 1000,      // 30 min
    medium: 20 * 60 * 1000,   // 20 min
    high: 10 * 60 * 1000,     // 10 min
    critical: 0,               // no cooldown for critical
};

/** How long a completed/failed run is retained for deduplication (ms). */
const RECENT_RUN_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── PlanRunRegistry ─────────────────────────────────────────────────────────

export class PlanRunRegistry {
    /** All runs indexed by runId. */
    private runs: Map<string, PlanRun> = new Map();

    /** Current active run per subsystem (subsystemId → runId). */
    private activeLocks: Map<string, string> = new Map();

    /** Cooldown expiry per subsystem (subsystemId → expiry unix ms). */
    private cooldowns: Map<string, SubsystemCooldownState> = new Map();

    // ── Fingerprinting ──────────────────────────────────────────────────────────

    /**
     * Computes a normalised, deterministic fingerprint for a trigger.
     *
     * The time bucket is truncated to the current hour so that repeated
     * triggers within the same hour share the same fingerprint.
     */
    computeFingerprint(input: PlanTriggerInput): TriggerFingerprint {
        const now = new Date();
        // Round down to the start of the current hour
        now.setMinutes(0, 0, 0);
        const timeBucket = now.toISOString();

        const raw = [
            input.subsystemId,
            input.issueType,
            input.normalizedTarget.toLowerCase().trim(),
            timeBucket,
        ].join('|');

        const hash = this._simpleHash(raw);

        return {
            subsystemId: input.subsystemId,
            issueType: input.issueType,
            normalizedTarget: input.normalizedTarget.toLowerCase().trim(),
            timeBucket,
            hash,
        };
    }

    // ── Deduplication ───────────────────────────────────────────────────────────

    /**
     * Checks whether an active or recent run already covers the given
     * fingerprint.
     *
     * Returns the existing run ID if found, so the caller can attach to it.
     */
    checkDuplicate(fingerprint: TriggerFingerprint): DedupCheckResult {
        const cutoff = Date.now() - RECENT_RUN_WINDOW_MS;

        for (const run of this.runs.values()) {
            if (run.trigger.hash !== fingerprint.hash) continue;

            const isActive = run.status === 'running' || run.status === 'pending';
            const isRecent = new Date(run.createdAt).getTime() >= cutoff;

            if (isActive || isRecent) {
                telemetry.operational(
                    'planning',
                    'planning.dedup.hit',
                    'debug',
                    'PlanRunRegistry',
                    `Duplicate fingerprint ${fingerprint.hash} — attached to run ${run.runId}`,
                );
                return {
                    isDuplicate: true,
                    existingRunId: run.runId,
                    existingRunStatus: run.status,
                };
            }
        }

        return { isDuplicate: false };
    }

    // ── Active-run lock ─────────────────────────────────────────────────────────

    /** Returns true when a run is currently active for the given subsystem. */
    isSubsystemLocked(subsystemId: string): boolean {
        const runId = this.activeLocks.get(subsystemId);
        if (!runId) return false;

        const run = this.runs.get(runId);
        if (!run) {
            // Stale lock — clean up
            this.activeLocks.delete(subsystemId);
            return false;
        }

        const isActive = run.status === 'running' || run.status === 'pending';
        if (!isActive) {
            this.activeLocks.delete(subsystemId);
            return false;
        }

        return true;
    }

    /** Acquires the active-run lock for the given subsystem. */
    lockSubsystem(subsystemId: string, runId: string): void {
        this.activeLocks.set(subsystemId, runId);
    }

    /** Releases the active-run lock for the given subsystem. */
    unlockSubsystem(subsystemId: string): void {
        this.activeLocks.delete(subsystemId);
    }

    /** Returns the active run for a subsystem, or null. */
    getActiveRun(subsystemId: string): PlanRun | null {
        const runId = this.activeLocks.get(subsystemId);
        return runId ? (this.runs.get(runId) ?? null) : null;
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────

    /**
     * Returns true when the subsystem is within its cooldown window.
     *
     * Critical severity and manual triggers bypass this check entirely
     * — callers are responsible for passing the right arguments.
     */
    isInCooldown(subsystemId: string): boolean {
        const state = this.cooldowns.get(subsystemId);
        if (!state) return false;

        if (Date.now() < state.expiresAt) return true;

        // Expired — clean up
        this.cooldowns.delete(subsystemId);
        return false;
    }

    /**
     * Imposes a cooldown on the subsystem after a run completes.
     *
     * The duration is derived from the severity of the trigger that started
     * the run.  Pass `durationMs = 0` to clear any existing cooldown.
     */
    setCooldown(subsystemId: string, severity: string, reason: string): void {
        const durationMs = COOLDOWN_MS[severity] ?? COOLDOWN_MS['medium'];
        if (durationMs === 0) return;

        this.cooldowns.set(subsystemId, {
            subsystemId,
            expiresAt: Date.now() + durationMs,
            reason,
        });

        telemetry.operational(
            'planning',
            'planning.cooldown.set',
            'debug',
            'PlanRunRegistry',
            `Cooldown for ${subsystemId}: ${durationMs}ms — ${reason}`,
        );
    }

    /** Returns the current cooldown state for a subsystem, or null. */
    getCooldown(subsystemId: string): SubsystemCooldownState | null {
        const state = this.cooldowns.get(subsystemId);
        if (!state) return null;
        if (Date.now() >= state.expiresAt) {
            this.cooldowns.delete(subsystemId);
            return null;
        }
        return { ...state };
    }

    // ── Run management ──────────────────────────────────────────────────────────

    /** Registers a newly-created run. */
    registerRun(run: PlanRun): void {
        this.runs.set(run.runId, { ...run });
    }

    /**
     * Applies a partial update to an existing run.
     * Also updates `updatedAt` automatically.
     */
    updateRun(runId: string, update: Partial<PlanRun>): void {
        const existing = this.runs.get(runId);
        if (!existing) return;
        this.runs.set(runId, {
            ...existing,
            ...update,
            updatedAt: new Date().toISOString(),
        });
    }

    /** Returns the run record for the given ID, or null. */
    getRun(runId: string): PlanRun | null {
        return this.runs.get(runId) ?? null;
    }

    /**
     * Returns all runs that started within the given recency window.
     * @param windowMs Time window in milliseconds (default: 1 hour).
     */
    listRecent(windowMs = 60 * 60 * 1000): PlanRun[] {
        const cutoff = Date.now() - windowMs;
        return Array.from(this.runs.values())
            .filter(r => new Date(r.createdAt).getTime() >= cutoff)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /**
     * Removes runs older than the retention window to prevent unbounded
     * memory growth.  Should be called periodically (e.g., on each tick).
     * @param retentionMs Retention window in ms (default: 4 hours).
     */
    pruneOldRuns(retentionMs = 4 * 60 * 60 * 1000): number {
        const cutoff = Date.now() - retentionMs;
        let pruned = 0;
        for (const [id, run] of this.runs) {
            if (new Date(run.createdAt).getTime() < cutoff) {
                this.runs.delete(id);
                pruned++;
            }
        }
        return pruned;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Deterministic hash of a string.
     * Not cryptographic — used only for fingerprint equality checks.
     */
    private _simpleHash(input: string): string {
        let h = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) {
            h ^= input.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }
}
