/**
 * InvariantRegistry — Phase 1D
 *
 * Loads and serves the hand-authored invariant definitions from
 * data/self_model/invariant_registry.json.
 *
 * All invariants are explicitly declared — no runtime inference.
 * The registry is immutable after loading.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InvariantRecord, InvariantRegistry as InvariantRegistryData } from '../../../shared/selfModelTypes';

export class InvariantRegistry {
    private data: InvariantRegistryData | null = null;
    private readonly registryPath: string;

    constructor(dataDir: string) {
        this.registryPath = path.join(dataDir, 'invariant_registry.json');
    }

    /**
     * Load the invariant registry from disk.
     * Returns true on success, false if file is missing or invalid.
     */
    public load(): boolean {
        try {
            const raw = fs.readFileSync(this.registryPath, 'utf-8');
            const parsed = JSON.parse(raw) as InvariantRegistryData;
            if (!Array.isArray(parsed.invariants)) {
                console.error('[InvariantRegistry] Invalid format: invariants must be an array');
                return false;
            }
            this.data = parsed;
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[InvariantRegistry] Failed to load from ${this.registryPath}: ${msg}`);
            return false;
        }
    }

    /** Returns all invariants, or empty array if not loaded. */
    public getAll(): InvariantRecord[] {
        return this.data?.invariants ?? [];
    }

    /** Returns the registry metadata (version, date). */
    public getMeta(): { version: string; lastReviewedAt: string } | null {
        if (!this.data) return null;
        return { version: this.data.version, lastReviewedAt: this.data.lastReviewedAt };
    }

    /** Look up an invariant by id. */
    public getById(id: string): InvariantRecord | undefined {
        return this.data?.invariants.find(i => i.id === id);
    }

    /** Get all invariants that apply to a given subsystem id. */
    public getBySubsystem(subsystemId: string): InvariantRecord[] {
        return (this.data?.invariants ?? []).filter(i => i.appliesToSubsystems.includes(subsystemId));
    }

    /** Get all invariants of a given severity. */
    public getBySeverity(severity: InvariantRecord['severity']): InvariantRecord[] {
        return (this.data?.invariants ?? []).filter(i => i.severity === severity);
    }

    /** Get all invariants with a given enforcement mode. */
    public getByEnforcementMode(mode: InvariantRecord['enforcementMode']): InvariantRecord[] {
        return (this.data?.invariants ?? []).filter(i => i.enforcementMode === mode);
    }

    /** True when the registry has been loaded successfully. */
    public isLoaded(): boolean {
        return this.data !== null;
    }

    /** Returns the raw registry data. */
    public getData(): InvariantRegistryData | null {
        return this.data;
    }
}
