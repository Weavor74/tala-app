/**
 * CapabilityRegistry.ts — Runtime Capability Registry
 *
 * Phase 1 Self-Model Foundation
 *
 * Loads and serves the registry of Tala's runtime capabilities. Defaults are
 * bundled with the application; a runtime override file in the user data
 * directory can extend or override defaults.
 *
 * Non-fatal: missing runtime override silently falls back to bundled defaults.
 */

import fs from 'fs';
import path from 'path';
import type { SelfModelCapability, CapabilityCategory, CapabilityStatus } from '../../../shared/selfModelTypes';

export class CapabilityRegistry {
    static readonly DEFAULT_PATH = path.join(__dirname, 'defaults', 'capability_registry.json');

    private capabilities: SelfModelCapability[] = [];

    /**
     * Loads capabilities from the bundled defaults. If runtimeOverridePath is
     * provided and the file exists, its entries are merged on top (by id).
     */
    load(runtimeOverridePath?: string): void {
        const defaults = this._readFile(CapabilityRegistry.DEFAULT_PATH);
        const merged: Map<string, SelfModelCapability> = new Map();
        for (const cap of defaults) {
            merged.set(cap.id, cap);
        }

        if (runtimeOverridePath) {
            try {
                if (fs.existsSync(runtimeOverridePath)) {
                    const overrides = this._readFile(runtimeOverridePath);
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

    private _readFile(filePath: string): SelfModelCapability[] {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.capabilities as SelfModelCapability[];
    }
}
