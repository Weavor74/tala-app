import type {
    DerivedCleanupRequest,
    DerivedCleanupReport,
    DerivedCleanupLayerOutcome,
    DerivedCleanupItemOutcome,
} from '../../../shared/memory/authorityTypes';
import type { MemoryService } from '../MemoryService';
import { MemoryAuthorityService } from './MemoryAuthorityService';
import { TelemetryBus } from '../telemetry/TelemetryBus';

/**
 * Coordinates canonical-to-derived cleanup across supported in-repo layers.
 *
 * Canonical status remains the source of truth; this service never infers
 * authority from derived state.
 */
export class DerivedMemoryCleanupService {
    constructor(
        private readonly authorityService: MemoryAuthorityService,
        private readonly memoryService: MemoryService,
    ) {}

    public async cleanupInactiveDerivedArtifacts(
        request: DerivedCleanupRequest = {},
    ): Promise<DerivedCleanupReport> {
        const authorityReport = await this.authorityService.cleanupDerivedState(request);
        const executionId = `mem-cleanup-local-${Date.now()}`;
        const bus = TelemetryBus.getInstance();
        const failures = [...authorityReport.failures];
        let cleanedCount = authorityReport.cleaned_count;
        let invalidatedCount = authorityReport.invalidated_count;
        let skippedCount = authorityReport.skipped_count;
        let noopCount = authorityReport.noop_count;
        let failedCount = authorityReport.failed_count;

        if (!authorityReport.layers_attempted.includes('local_projection_store')) {
            authorityReport.layers_attempted.push('local_projection_store');
        }

        const itemOutcomes: DerivedCleanupItemOutcome[] = [];
        for (const item of authorityReport.item_outcomes) {
            const layerOutcomes: DerivedCleanupLayerOutcome[] = [...item.layer_outcomes];
            if (item.authority_status !== 'tombstoned' && item.authority_status !== 'superseded') {
                layerOutcomes.push({
                    layer: 'local_projection_store',
                    outcome: 'skipped',
                    detail: `canonical_status_not_inactive:${item.authority_status}`,
                });
                skippedCount++;
                itemOutcomes.push({
                    ...item,
                    layer_outcomes: layerOutcomes,
                });
                continue;
            }

            try {
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.derived_cleanup_layer_started',
                    payload: {
                        memory_id: item.canonical_memory_id,
                        layer: 'local_projection_store',
                    },
                });
                const removed = await this.memoryService.removeDerivedProjectionForCanonical(item.canonical_memory_id);
                if (removed) {
                    layerOutcomes.push({
                        layer: 'local_projection_store',
                        outcome: 'cleaned',
                        detail: 'removed_local_derived_projection',
                    });
                    cleanedCount++;
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_cleanup_layer_completed',
                        payload: {
                            memory_id: item.canonical_memory_id,
                            layer: 'local_projection_store',
                            outcome: 'cleaned',
                        },
                    });
                } else {
                    layerOutcomes.push({
                        layer: 'local_projection_store',
                        outcome: 'skipped',
                        detail: 'no_local_projection_found',
                    });
                    skippedCount++;
                }
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                layerOutcomes.push({
                    layer: 'local_projection_store',
                    outcome: 'failed',
                    detail: reason,
                });
                failures.push({
                    canonical_memory_id: item.canonical_memory_id,
                    layer: 'local_projection_store',
                    reason,
                });
                failedCount++;
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.derived_cleanup_layer_failed',
                    payload: {
                        memory_id: item.canonical_memory_id,
                        layer: 'local_projection_store',
                        reason,
                    },
                });
            }

            itemOutcomes.push({
                ...item,
                layer_outcomes: layerOutcomes,
            });
        }

        return {
            ...authorityReport,
            cleaned_count: cleanedCount,
            invalidated_count: invalidatedCount,
            skipped_count: skippedCount,
            noop_count: noopCount,
            failed_count: failedCount,
            item_outcomes: itemOutcomes,
            failures,
            partial_failure: failedCount > 0,
        };
    }
}
