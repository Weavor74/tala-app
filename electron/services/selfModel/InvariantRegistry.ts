/**
 * InvariantRegistry.ts — Architectural Invariant Registry
 *
 * Phase 1 Self-Model Foundation
 *
 * Loads and serves the registry of Tala's architectural and behavioral
 * invariants. Defaults are bundled with the application; a runtime override
 * file in the user data directory can extend or override defaults.
 *
 * Non-fatal: missing runtime override silently falls back to bundled defaults.
 */

import fs from 'fs';
import path from 'path';
import type { SelfModelInvariant, InvariantCategory, InvariantStatus } from '../../../shared/selfModelTypes';

export class InvariantRegistry {
    static readonly DEFAULT_PATH = path.join(__dirname, 'defaults', 'invariant_registry.json');

    private invariants: SelfModelInvariant[] = [];

    /**
     * Loads invariants from the bundled defaults. If runtimeOverridePath is
     * provided and the file exists, its invariants are merged on top (by id).
     */
    load(runtimeOverridePath?: string): void {
        const defaults = this._readFile(InvariantRegistry.DEFAULT_PATH);
        const merged: Map<string, SelfModelInvariant> = new Map();
        for (const inv of defaults) {
            merged.set(inv.id, inv);
        }

        if (runtimeOverridePath) {
            try {
                if (fs.existsSync(runtimeOverridePath)) {
                    const overrides = this._readFile(runtimeOverridePath);
                    for (const inv of overrides) {
                        merged.set(inv.id, inv);
                    }
                }
            } catch (err) {
                console.warn('[InvariantRegistry] Non-fatal: could not load runtime override:', err);
            }
        }

        this.invariants = Array.from(merged.values());
    }

    getAll(): SelfModelInvariant[] {
        return this.invariants;
    }

    getById(id: string): SelfModelInvariant | undefined {
        return this.invariants.find(inv => inv.id === id);
    }

    getByCategory(cat: InvariantCategory): SelfModelInvariant[] {
        return this.invariants.filter(inv => inv.category === cat);
    }

    getActive(): SelfModelInvariant[] {
        return this.invariants.filter(inv => inv.status === 'active');
    }

    count(): number {
        return this.invariants.length;
    }

    private _readFile(filePath: string): SelfModelInvariant[] {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.invariants as SelfModelInvariant[];
    }
}
