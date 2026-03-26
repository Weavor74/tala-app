/**
 * CapabilityRegistry.ts — Runtime Capability Registry
 *
 * Phase 1 Self-Model Foundation
 *
 * Loads and serves the registry of Tala's runtime capabilities. Bundled
 * defaults are imported from TypeScript constants in
 * defaults/capabilityRegistry.ts and are available on a fresh clone with no
 * manual file placement. An optional runtime override JSON file in the user
 * data directory may extend or override defaults but is never required.
 *
 * Non-fatal: missing runtime override silently falls back to bundled defaults.
 */

import fs from 'fs';
import type { SelfModelCapability, CapabilityCategory } from '../../../shared/selfModelTypes';
import { DEFAULT_CAPABILITIES } from './defaults/capabilityRegistry';

export class CapabilityRegistry {
    private capabilities: SelfModelCapability[] = [];

    /**
     * Loads capabilities from the bundled TypeScript defaults. If
     * runtimeOverridePath is provided and the file exists, its entries are
     * merged on top (by id). The bundled defaults are always authoritative as
     * the baseline — no fs I/O is required for the bundled set.
     */
    load(runtimeOverridePath?: string): void {
        const merged: Map<string, SelfModelCapability> = new Map();
        for (const cap of DEFAULT_CAPABILITIES) {
            merged.set(cap.id, cap);
        }

        if (runtimeOverridePath) {
            try {
                if (fs.existsSync(runtimeOverridePath)) {
                    const raw = fs.readFileSync(runtimeOverridePath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    const overrides: SelfModelCapability[] = parsed.capabilities ?? [];
                    for (const cap of overrides) {
                        merged.set(cap.id, cap);
                    }
                }
            } catch (err) {
                console.warn('[CapabilityRegistry] Non-fatal: could not load runtime override:', err);
            }
        }

        this.capabilities = Array.from(merged.values());
    }

    getAll(): SelfModelCapability[] {
        return this.capabilities;
    }

    getById(id: string): SelfModelCapability | undefined {
        return this.capabilities.find(cap => cap.id === id);
    }

    getByCategory(cat: CapabilityCategory): SelfModelCapability[] {
        return this.capabilities.filter(cap => cap.category === cat);
    }

    getAvailable(): SelfModelCapability[] {
        return this.capabilities.filter(cap => cap.status === 'available');
    }

    count(): number {
        return this.capabilities.length;
    }
}
