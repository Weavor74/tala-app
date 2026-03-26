/**
 * CapabilityRegistry — Phase 1E
 *
 * Loads and serves the hand-authored capability definitions from
 * data/self_model/capability_registry.json.
 *
 * All capabilities are explicitly declared — no aspirational entries.
 * Only marks 'available: true' for capabilities that are actually implemented.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CapabilityRecord, CapabilityRegistry as CapabilityRegistryData } from '../../../shared/selfModelTypes';

export class CapabilityRegistry {
    private data: CapabilityRegistryData | null = null;
    private readonly registryPath: string;

    constructor(dataDir: string) {
        this.registryPath = path.join(dataDir, 'capability_registry.json');
    }

    /**
     * Load the capability registry from disk.
     * Returns true on success, false if file is missing or invalid.
     */
    public load(): boolean {
        try {
            const raw = fs.readFileSync(this.registryPath, 'utf-8');
            const parsed = JSON.parse(raw) as CapabilityRegistryData;
            if (!Array.isArray(parsed.capabilities)) {
                console.error('[CapabilityRegistry] Invalid format: capabilities must be an array');
                return false;
            }
            this.data = parsed;
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[CapabilityRegistry] Failed to load from ${this.registryPath}: ${msg}`);
            return false;
        }
    }

    /** Returns all capability records, or empty array if not loaded. */
    public getAll(): CapabilityRecord[] {
        return this.data?.capabilities ?? [];
    }

    /** Returns the registry metadata. */
    public getMeta(): { version: string; lastReviewedAt: string } | null {
        if (!this.data) return null;
        return { version: this.data.version, lastReviewedAt: this.data.lastReviewedAt };
    }

    /** Look up a capability by id. */
    public getById(id: string): CapabilityRecord | undefined {
        return this.data?.capabilities.find(c => c.id === id);
    }

    /** Get all capabilities that are currently available. */
    public getAvailable(): CapabilityRecord[] {
        return (this.data?.capabilities ?? []).filter(c => c.available);
    }

    /** Get capabilities accessible in a given mode. */
    public getByMode(mode: string): CapabilityRecord[] {
        return (this.data?.capabilities ?? []).filter(c => !c.allowedModes || c.allowedModes.includes(mode));
    }

    /** Get capabilities exposed via a specific IPC channel. */
    public getByIpcChannel(channel: string): CapabilityRecord[] {
        return (this.data?.capabilities ?? []).filter(c => c.ipcChannels?.includes(channel));
    }

    /** True when the registry has been loaded successfully. */
    public isLoaded(): boolean {
        return this.data !== null;
    }

    /** Returns the raw registry data. */
    public getData(): CapabilityRegistryData | null {
        return this.data;
    }
}
