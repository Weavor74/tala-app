/**
 * SelfModelBuilder.ts — Snapshot Assembler
 *
 * Phase 1 Self-Model Foundation
 *
 * Assembles a SelfModelSnapshot from the provided registries and inventory.
 * Purely functional: all state is owned by callers.
 */

import type {
    SelfModelSnapshot,
    SelfModelInvariant,
    SelfModelCapability,
    SelfModelComponent,
    OwnershipEntry,
} from '../../../shared/selfModelTypes';

export class SelfModelBuilder {
    build(
        invariants: SelfModelInvariant[],
        capabilities: SelfModelCapability[],
        components: SelfModelComponent[],
        ownershipMap: OwnershipEntry[],
    ): SelfModelSnapshot {
        return {
            generatedAt: new Date().toISOString(),
            invariants,
            capabilities,
            components,
            ownershipMap,
        };
    }
}
