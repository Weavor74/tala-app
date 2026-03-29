/**
 * ExecutionRunRegistry.ts — Phase 3 P3B
 *
 * In-memory registry for execution runs.
 *
 * Enforces:
 * 1. Active-run lock — one active execution per subsystem at a time.
 * 2. Subsystem cooldown — post-execution cooldown (default 5 min success,
 *    15 min failure) to prevent rapid re-execution.
 *
 * No persistence — execution run state is persisted by ExecutionAuditService.
 * This registry is purely an in-memory coordination layer.
 */

import type { ExecutionRun, ExecutionStatus } from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── Constants ────────────────────────────────────────────────────────────────

const COOLDOWN_MS = {
    success: 5 * 60 * 1000,   // 5 min after successful execution
    failure: 15 * 60 * 1000,  // 15 min after failed/aborted execution
} as const;

const RECENT_RUN_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

interface CooldownState {
    subsystemId: string;
    expiresAt: number;
    reason: string;
}

const ACTIVE_STATUSES = new Set<ExecutionStatus>([
    'pending_execution',
    'validating',
    'ready_to_apply',
    'applying',
    'verifying',
    'failed_verification',
    'rollback_pending',
    'rolling_back',
]);

// ─── ExecutionRunRegistry ─────────────────────────────────────────────────────

export class ExecutionRunRegistry {
    private runs: Map<string, ExecutionRun> = new Map();
    private activeLocks: Map<string, string> = new Map();   // subsystemId → executionId
    private cooldowns: Map<string, CooldownState> = new Map();

    // ── Active-run lock ─────────────────────────────────────────────────────────

    isSubsystemLocked(subsystemId: string): boolean {
        const executionId = this.activeLocks.get(subsystemId);
        if (!executionId) return false;

        const run = this.runs.get(executionId);
        if (!run) {
            this.activeLocks.delete(subsystemId);
            return false;
        }

        if (!ACTIVE_STATUSES.has(run.status)) {
            this.activeLocks.delete(subsystemId);
            return false;
        }

        return true;
    }

    lockSubsystem(subsystemId: string, executionId: string): void {
        this.activeLocks.set(subsystemId, executionId);
    }

    unlockSubsystem(subsystemId: string): void {
        this.activeLocks.delete(subsystemId);
    }

    getActiveRun(subsystemId: string): ExecutionRun | null {
        const executionId = this.activeLocks.get(subsystemId);
        return executionId ? (this.runs.get(executionId) ?? null) : null;
    }

    // ── Cooldown ────────────────────────────────────────────────────────────────

    isInCooldown(subsystemId: string): boolean {
        const state = this.cooldowns.get(subsystemId);
        if (!state) return false;
        if (Date.now() < state.expiresAt) return true;
        this.cooldowns.delete(subsystemId);
        return false;
    }

    setCooldown(subsystemId: string, outcome: 'success' | 'failure', reason: string): void {
        const durationMs = COOLDOWN_MS[outcome];
        this.cooldowns.set(subsystemId, {
            subsystemId,
            expiresAt: Date.now() + durationMs,
            reason,
        });
        telemetry.operational(
            'execution',
            'execution.cooldown.set',
            'debug',
            'ExecutionRunRegistry',
            `Cooldown for ${subsystemId}: ${durationMs}ms — ${reason}`,
        );
    }

    getCooldown(subsystemId: string): CooldownState | null {
        const state = this.cooldowns.get(subsystemId);
        if (!state) return null;
        if (Date.now() >= state.expiresAt) {
            this.cooldowns.delete(subsystemId);
            return null;
        }
        return { ...state };
    }

    // ── Run management ──────────────────────────────────────────────────────────

    registerRun(run: ExecutionRun): void {
        this.runs.set(run.executionId, { ...run });
    }

    updateRun(executionId: string, update: Partial<ExecutionRun>): void {
        const existing = this.runs.get(executionId);
        if (!existing) return;
        this.runs.set(executionId, {
            ...existing,
            ...update,
            updatedAt: new Date().toISOString(),
        });
    }

    getRun(executionId: string): ExecutionRun | null {
        return this.runs.get(executionId) ?? null;
    }

    listRecent(windowMs = RECENT_RUN_WINDOW_MS): ExecutionRun[] {
        const cutoff = Date.now() - windowMs;
        return Array.from(this.runs.values())
            .filter(r => new Date(r.createdAt).getTime() >= cutoff)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

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
}
