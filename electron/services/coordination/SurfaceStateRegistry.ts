/**
 * SurfaceStateRegistry — Phase 4D: Convergence & Coordination
 *
 * Tracks all active A2UI surfaces and their lifecycle state.
 * Used by SurfacePolicyEngine and A2UISurfaceCoordinator to prevent
 * duplicate tabs, enforce cooldowns, and detect stale surfaces.
 *
 * Rules:
 * - Singleton-friendly (constructed with dependencies, not hard-coupled singletons).
 * - All state is in-memory for this session only.
 * - Cooldown windows prevent repeated open actions.
 * - Data hashing suppresses no-op updates.
 */

import type { A2UISurfaceId } from '../../../shared/a2uiTypes';
import type {
    SurfaceStateEntry,
    SurfaceStateUpdateOptions,
} from '../../../shared/coordinationTypes';

// ─── Default cooldown ─────────────────────────────────────────────────────────

/** Default cooldown window for surface opens (ms). */
const DEFAULT_COOLDOWN_MS = 30_000;

// ─── SurfaceStateRegistry ─────────────────────────────────────────────────────

/**
 * SurfaceStateRegistry
 *
 * Tracks open surfaces, data hashes, and cooldown state.
 * The policy engine and coordinator consult this registry before acting.
 */
export class SurfaceStateRegistry {
    private readonly _surfaces = new Map<A2UISurfaceId, SurfaceStateEntry>();
    private readonly _cooldownMs: number;

    constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) {
        this._cooldownMs = cooldownMs;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Records that a surface was opened.
     * Resets the cooldown timer and increments the open counter.
     */
    public markOpened(surfaceId: A2UISurfaceId, opts: SurfaceStateUpdateOptions = {}): void {
        const existing = this._surfaces.get(surfaceId);
        const now = new Date().toISOString();
        this._surfaces.set(surfaceId, {
            surfaceId,
            isOpen: true,
            lastUpdatedAt: now,
            lastDataHash: opts.dataHash ?? existing?.lastDataHash ?? '',
            isFocused: opts.isFocused ?? false,
            openCount: (existing?.openCount ?? 0) + 1,
            lastFocusedAt: opts.isFocused ? now : existing?.lastFocusedAt,
        });
    }

    /**
     * Records that a surface was updated in-place (no new tab created).
     * Does NOT reset the cooldown timer.
     */
    public markUpdated(surfaceId: A2UISurfaceId, opts: SurfaceStateUpdateOptions = {}): void {
        const existing = this._surfaces.get(surfaceId);
        const now = new Date().toISOString();
        this._surfaces.set(surfaceId, {
            surfaceId,
            isOpen: existing?.isOpen ?? true,
            lastUpdatedAt: now,
            lastDataHash: opts.dataHash ?? existing?.lastDataHash ?? '',
            isFocused: opts.isFocused ?? existing?.isFocused ?? false,
            openCount: existing?.openCount ?? 1,
            lastFocusedAt: opts.isFocused ? now : existing?.lastFocusedAt,
        });
    }

    /**
     * Records that a surface was closed.
     */
    public markClosed(surfaceId: A2UISurfaceId): void {
        const existing = this._surfaces.get(surfaceId);
        if (existing) {
            this._surfaces.set(surfaceId, { ...existing, isOpen: false });
        }
    }

    /**
     * Returns whether a surface is currently open.
     */
    public isOpen(surfaceId: A2UISurfaceId): boolean {
        return this._surfaces.get(surfaceId)?.isOpen ?? false;
    }

    /**
     * Returns whether a surface is within its cooldown window.
     * Cooldown is based on the last time the surface was opened (not updated).
     */
    public isOnCooldown(surfaceId: A2UISurfaceId): boolean {
        const entry = this._surfaces.get(surfaceId);
        if (!entry || !entry.isOpen) return false;
        const lastOpened = new Date(entry.lastUpdatedAt).getTime();
        const elapsed = Date.now() - lastOpened;
        return elapsed < this._cooldownMs;
    }

    /**
     * Returns the last data hash for a surface.
     * Used to suppress no-op updates when data hasn't changed.
     */
    public getLastDataHash(surfaceId: A2UISurfaceId): string {
        return this._surfaces.get(surfaceId)?.lastDataHash ?? '';
    }

    /**
     * Returns the full state entry for a surface, or undefined if never opened.
     */
    public getEntry(surfaceId: A2UISurfaceId): SurfaceStateEntry | undefined {
        return this._surfaces.get(surfaceId);
    }

    /**
     * Returns all surface state entries.
     */
    public getAllEntries(): SurfaceStateEntry[] {
        return Array.from(this._surfaces.values());
    }

    /**
     * Returns all currently open surfaces.
     */
    public getOpenSurfaces(): SurfaceStateEntry[] {
        return this.getAllEntries().filter(e => e.isOpen);
    }

    /**
     * Resets the registry — used between sessions or for testing.
     */
    public reset(): void {
        this._surfaces.clear();
    }
}
