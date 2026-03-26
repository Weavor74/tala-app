/**
 * SelfModelRefreshService.ts — Registry Initialization and Refresh
 *
 * Phase 1 Self-Model Foundation
 *
 * Handles loading the invariant and capability registries on startup and on
 * demand. Loads bundled defaults unconditionally and applies runtime overrides
 * from the user data directory if they exist (non-fatal if absent).
 */

import path from 'path';
import type { SelfModelRefreshResult } from '../../../shared/selfModelTypes';
import type { InvariantRegistry } from './InvariantRegistry';
import type { CapabilityRegistry } from './CapabilityRegistry';
import type { SelfModelQueryService } from './SelfModelQueryService';

export class SelfModelRefreshService {
    private initialized = false;
    private lastResult: SelfModelRefreshResult | null = null;

    constructor(
        private invariantRegistry: InvariantRegistry,
        private capabilityRegistry: CapabilityRegistry,
        private queryService: SelfModelQueryService,
        private dataDir: string,
    ) {}

    async init(): Promise<SelfModelRefreshResult> {
        return this._load();
    }

    async refresh(): Promise<SelfModelRefreshResult> {
        return this._load();
    }

    getLastRefreshResult(): SelfModelRefreshResult | null {
        return this.lastResult;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    private async _load(): Promise<SelfModelRefreshResult> {
        const timestamp = new Date().toISOString();
        try {
            const invariantOverridePath = path.join(this.dataDir, 'self_model', 'invariant_registry.json');
            this.invariantRegistry.load(invariantOverridePath);

            const capabilityOverridePath = path.join(this.dataDir, 'self_model', 'capability_registry.json');
            this.capabilityRegistry.load(capabilityOverridePath);

            const components = this.queryService.getComponents();

            const result: SelfModelRefreshResult = {
                success: true,
                timestamp,
                invariantsLoaded: this.invariantRegistry.count(),
                capabilitiesLoaded: this.capabilityRegistry.count(),
                componentsScanned: components.length,
            };

            this.lastResult = result;
            this.initialized = true;
            return result;
        } catch (err: any) {
            const result: SelfModelRefreshResult = {
                success: false,
                timestamp,
                invariantsLoaded: this.invariantRegistry.count(),
                capabilitiesLoaded: this.capabilityRegistry.count(),
                componentsScanned: 0,
                error: err?.message ?? String(err),
            };
            this.lastResult = result;
            this.initialized = false;
            return result;
        }
    }
}
