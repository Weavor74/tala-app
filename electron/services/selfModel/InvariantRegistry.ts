/**
 * InvariantRegistry.ts — Architectural Invariant Registry
 *
 * Phase 1 Self-Model Foundation
 *
 * Loads and serves the registry of Tala's architectural and behavioral
 * invariants. Bundled defaults are imported from TypeScript constants in
 * defaults/invariantRegistry.ts and are available on a fresh clone with no
 * manual file placement. An optional runtime override JSON file in the user
 * data directory may extend or override defaults but is never required.
 *
 * Non-fatal: missing runtime override silently falls back to bundled defaults.
 */

import fs from 'fs';
import type { SelfModelInvariant, InvariantCategory } from '../../../shared/selfModelTypes';
import { DEFAULT_INVARIANTS } from './defaults/invariantRegistry';

export class InvariantRegistry {
    private invariants: SelfModelInvariant[] = [];

    /**
     * Loads invariants from the bundled TypeScript defaults. If
     * runtimeOverridePath is provided and the file exists, its invariants are
     * merged on top (by id). The bundled defaults are always authoritative as
     * the baseline — no fs I/O is required for the bundled set.
     */
    load(runtimeOverridePath?: string): void {
        const merged: Map<string, SelfModelInvariant> = new Map();
        for (const inv of DEFAULT_INVARIANTS) {
            merged.set(inv.id, inv);
        }

        if (runtimeOverridePath) {
            try {
                if (fs.existsSync(runtimeOverridePath)) {
                    const raw = fs.readFileSync(runtimeOverridePath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    const overrides: SelfModelInvariant[] = parsed.invariants ?? [];
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
}
