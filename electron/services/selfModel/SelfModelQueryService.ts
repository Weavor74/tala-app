/**
 * SelfModelQueryService.ts — Self-Model Query Interface
 *
 * Phase 1 Self-Model Foundation
 *
 * Wraps the registries and scanner to provide filtered query access to the
 * self-model. Assembles snapshots and architecture summaries on demand.
 */

import type {
    SelfModelSnapshot,
    SelfModelComponent,
    OwnershipEntry,
    InvariantQueryResult,
    CapabilityQueryResult,
    ArchitectureSummary,
    InvariantCategory,
    InvariantStatus,
    CapabilityCategory,
    CapabilityStatus,
} from '../../../shared/selfModelTypes';
import type { InvariantRegistry } from './InvariantRegistry';
import type { CapabilityRegistry } from './CapabilityRegistry';
import type { OwnershipMapper } from './OwnershipMapper';
import type { SelfModelScanner } from './SelfModelScanner';
import type { SelfModelBuilder } from './SelfModelBuilder';

export class SelfModelQueryService {
    private lastRefreshed: string | null = null;

    constructor(
        private invariantRegistry: InvariantRegistry,
        private capabilityRegistry: CapabilityRegistry,
        private ownershipMapper: OwnershipMapper,
        private scanner: SelfModelScanner,
        private builder: SelfModelBuilder,
    ) {}

    getSnapshot(): SelfModelSnapshot {
        const snapshot = this.builder.build(
            this.invariantRegistry.getAll(),
            this.capabilityRegistry.getAll(),
            this.scanner.scan(),
            this.ownershipMapper.getAll(),
        );
        this.lastRefreshed = snapshot.generatedAt;
        return snapshot;
    }

    queryInvariants(filter?: { category?: InvariantCategory; status?: InvariantStatus }): InvariantQueryResult {
        let invariants = this.invariantRegistry.getAll();

        if (filter?.category) {
            invariants = invariants.filter(inv => inv.category === filter.category);
        }
        if (filter?.status) {
            invariants = invariants.filter(inv => inv.status === filter.status);
        }

        return {
            invariants,
            total: invariants.length,
            filteredBy: filter ? { category: filter.category, status: filter.status } : undefined,
        };
    }

    queryCapabilities(filter?: { category?: CapabilityCategory; status?: CapabilityStatus }): CapabilityQueryResult {
        let capabilities = this.capabilityRegistry.getAll();

        if (filter?.category) {
            capabilities = capabilities.filter(cap => cap.category === filter.category);
        }
        if (filter?.status) {
            capabilities = capabilities.filter(cap => cap.status === filter.status);
        }

        return {
            capabilities,
            total: capabilities.length,
            filteredBy: filter ? { category: filter.category, status: filter.status } : undefined,
        };
    }

    getArchitectureSummary(): ArchitectureSummary {
        return {
            totalInvariants: this.invariantRegistry.count(),
            activeInvariants: this.invariantRegistry.getActive().length,
            totalCapabilities: this.capabilityRegistry.count(),
            availableCapabilities: this.capabilityRegistry.getAvailable().length,
            totalComponents: this.scanner.scan().length,
            lastRefreshed: this.lastRefreshed,
        };
    }

    getComponents(): SelfModelComponent[] {
        return this.scanner.scan();
    }

    getOwnershipMap(): OwnershipEntry[] {
        return this.ownershipMapper.getAll();
    }
}
