import type {
    LegacyMemoryBackfillReport,
    LegacyMemoryBackfillRequest,
    LegacyMemoryBackfillOutcome,
    ProposedMemoryInput,
} from '../../../shared/memory/authorityTypes';
import type { MemoryService, LegacyMemoryBackfillCandidate } from '../MemoryService';
import { MemoryAuthorityService } from './MemoryAuthorityService';
import { TelemetryBus } from '../telemetry/TelemetryBus';

type EligibilityResult =
    | { eligible: true; normalizedText: string }
    | { eligible: false; disposition: 'skip' | 'quarantine'; reason: string };

export class LegacyMemoryBackfillService {
    constructor(
        private readonly authorityService: MemoryAuthorityService,
        private readonly memoryService: MemoryService,
    ) {}

    public async backfillLegacyMemories(
        request: LegacyMemoryBackfillRequest = {},
    ): Promise<LegacyMemoryBackfillReport> {
        const startMs = Date.now();
        const runAt = new Date().toISOString();
        const executionId = `memory-backfill-${Date.now()}`;
        const bus = TelemetryBus.getInstance();
        const normalizedScope = this._normalizeRequestScope(request);

        const outcomes: LegacyMemoryBackfillOutcome[] = [];
        let scannedCount = 0;
        let eligibleCount = 0;
        let migratedCount = 0;
        let skippedCount = 0;
        let duplicateMergedCount = 0;
        let quarantinedCount = 0;
        let failedCount = 0;

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: 'memory.backfill_requested',
            payload: {
                dry_run: Boolean(request.dryRun),
                full_backfill: normalizedScope.fullBackfill,
                legacy_memory_ids: normalizedScope.legacyMemoryIds.length > 0 ? normalizedScope.legacyMemoryIds : 'all',
            },
        });

        const candidates = this.memoryService.getLegacyUnanchoredMemoriesForBackfill({
            legacyMemoryId: request.legacyMemoryId,
            legacyMemoryIds: request.legacyMemoryIds,
            fullBackfill: request.fullBackfill,
        });

        for (const candidate of candidates) {
            scannedCount++;
            bus.emit({
                executionId,
                subsystem: 'memory',
                event: 'memory.backfill_item_scanned',
                payload: { legacy_memory_id: candidate.legacy_memory_id },
            });

            try {
                const eligibility = this._evaluateEligibility(candidate);
                if (!eligibility.eligible) {
                    if (eligibility.disposition === 'quarantine') {
                        this.memoryService.quarantineLegacyMemoryForBackfill(
                            candidate.legacy_memory_id,
                            eligibility.reason,
                        );
                        quarantinedCount++;
                        outcomes.push({
                            legacy_memory_id: candidate.legacy_memory_id,
                            status: 'quarantined',
                            reason: eligibility.reason,
                        });
                        bus.emit({
                            executionId,
                            subsystem: 'memory',
                            event: 'memory.backfill_item_quarantined',
                            payload: {
                                legacy_memory_id: candidate.legacy_memory_id,
                                reason: eligibility.reason,
                            },
                        });
                    } else {
                        skippedCount++;
                        outcomes.push({
                            legacy_memory_id: candidate.legacy_memory_id,
                            status: 'skipped',
                            reason: eligibility.reason,
                        });
                        bus.emit({
                            executionId,
                            subsystem: 'memory',
                            event: 'memory.backfill_item_skipped',
                            payload: {
                                legacy_memory_id: candidate.legacy_memory_id,
                                reason: eligibility.reason,
                            },
                        });
                    }
                    continue;
                }

                eligibleCount++;
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.backfill_item_eligible',
                    payload: { legacy_memory_id: candidate.legacy_memory_id },
                });

                if (request.dryRun) {
                    skippedCount++;
                    outcomes.push({
                        legacy_memory_id: candidate.legacy_memory_id,
                        status: 'skipped',
                        reason: 'dry_run_eligible_no_write',
                    });
                    continue;
                }

                const proposedInput = this._buildCanonicalInput(candidate, eligibility.normalizedText);
                const duplicate = await this.authorityService.detectDuplicates(proposedInput);
                const isDuplicateLink = Boolean(duplicate.duplicate_found && duplicate.matched_memory_id);
                let canonicalMemoryId: string | null = duplicate.matched_memory_id ?? null;

                if (!canonicalMemoryId) {
                    const createResult = await this.authorityService.tryCreateCanonicalMemory(
                        proposedInput,
                        { executionId },
                    );
                    if (!createResult.success || !createResult.data) {
                        failedCount++;
                        outcomes.push({
                            legacy_memory_id: candidate.legacy_memory_id,
                            status: 'failed',
                            reason: createResult.error ?? 'canonical_create_failed',
                        });
                        bus.emit({
                            executionId,
                            subsystem: 'memory',
                            event: 'memory.backfill_item_failed',
                            payload: {
                                legacy_memory_id: candidate.legacy_memory_id,
                                reason: createResult.error ?? 'canonical_create_failed',
                            },
                        });
                        continue;
                    }
                    canonicalMemoryId = createResult.data;
                }

                const anchored = await this.memoryService.anchorLegacyMemoryToCanonical(
                    candidate.legacy_memory_id,
                    canonicalMemoryId,
                );
                if (!anchored) {
                    failedCount++;
                    this.memoryService.quarantineLegacyMemoryForBackfill(
                        candidate.legacy_memory_id,
                        'canonical_created_but_reanchor_failed',
                    );
                    outcomes.push({
                        legacy_memory_id: candidate.legacy_memory_id,
                        status: 'failed',
                        reason: 'canonical_created_but_reanchor_failed',
                        canonical_memory_id: canonicalMemoryId,
                    });
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.backfill_item_failed',
                        payload: {
                            legacy_memory_id: candidate.legacy_memory_id,
                            canonical_memory_id: canonicalMemoryId,
                            reason: 'canonical_created_but_reanchor_failed',
                        },
                    });
                    continue;
                }

                if (isDuplicateLink) {
                    duplicateMergedCount++;
                    outcomes.push({
                        legacy_memory_id: candidate.legacy_memory_id,
                        status: 'linked_existing',
                        reason: 'linked_to_existing_canonical_memory',
                        canonical_memory_id: canonicalMemoryId,
                    });
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.backfill_item_linked_existing',
                        payload: {
                            legacy_memory_id: candidate.legacy_memory_id,
                            canonical_memory_id: canonicalMemoryId,
                        },
                    });
                } else {
                    migratedCount++;
                    outcomes.push({
                        legacy_memory_id: candidate.legacy_memory_id,
                        status: 'migrated',
                        reason: 'canonical_memory_created_and_anchored',
                        canonical_memory_id: canonicalMemoryId,
                    });
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.backfill_item_canonicalized',
                        payload: {
                            legacy_memory_id: candidate.legacy_memory_id,
                            canonical_memory_id: canonicalMemoryId,
                        },
                    });
                }
            } catch (error) {
                failedCount++;
                const reason = error instanceof Error ? error.message : String(error);
                outcomes.push({
                    legacy_memory_id: candidate.legacy_memory_id,
                    status: 'failed',
                    reason,
                });
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.backfill_item_failed',
                    payload: {
                        legacy_memory_id: candidate.legacy_memory_id,
                        reason,
                    },
                });
            }
        }

        const partialFailure = failedCount > 0;
        const report: LegacyMemoryBackfillReport = {
            run_at: runAt,
            dry_run: Boolean(request.dryRun),
            request_scope: {
                legacy_memory_ids: normalizedScope.legacyMemoryIds.length > 0 ? normalizedScope.legacyMemoryIds : 'all',
                full_backfill: normalizedScope.fullBackfill,
            },
            scanned_count: scannedCount,
            eligible_count: eligibleCount,
            migrated_count: migratedCount,
            skipped_count: skippedCount,
            duplicate_merged_count: duplicateMergedCount,
            quarantined_count: quarantinedCount,
            failed_count: failedCount,
            outcomes,
            duration_ms: Date.now() - startMs,
            partial_failure: partialFailure,
        };

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: partialFailure ? 'memory.backfill_completed_with_partial_failures' : 'memory.backfill_completed',
            payload: {
                scanned_count: scannedCount,
                eligible_count: eligibleCount,
                migrated_count: migratedCount,
                skipped_count: skippedCount,
                duplicate_merged_count: duplicateMergedCount,
                quarantined_count: quarantinedCount,
                failed_count: failedCount,
                duration_ms: report.duration_ms,
            },
        });

        return report;
    }

    private _normalizeRequestScope(request: LegacyMemoryBackfillRequest): {
        legacyMemoryIds: string[];
        fullBackfill: boolean;
    } {
        const ids = new Set<string>();
        if (request.legacyMemoryId && request.legacyMemoryId.trim()) {
            ids.add(request.legacyMemoryId.trim());
        }
        for (const id of request.legacyMemoryIds ?? []) {
            if (id && id.trim()) ids.add(id.trim());
        }
        return {
            legacyMemoryIds: [...ids],
            fullBackfill: Boolean(request.fullBackfill),
        };
    }

    private _evaluateEligibility(candidate: LegacyMemoryBackfillCandidate): EligibilityResult {
        const text = candidate.text?.trim() ?? '';
        if (!text) {
            return {
                eligible: false,
                disposition: 'quarantine',
                reason: 'empty_or_invalid_content',
            };
        }

        if (candidate.status === 'archived' || candidate.status === 'superseded') {
            return {
                eligible: false,
                disposition: 'skip',
                reason: `inactive_legacy_status:${candidate.status}`,
            };
        }

        const metadata = candidate.metadata ?? {};
        if (metadata['deleted'] === true || metadata['tombstoned'] === true) {
            return {
                eligible: false,
                disposition: 'skip',
                reason: 'legacy_record_marked_deleted_or_tombstoned',
            };
        }

        if (metadata['canonical_memory_id']) {
            return {
                eligible: false,
                disposition: 'skip',
                reason: 'already_canonical_backed',
            };
        }

        return {
            eligible: true,
            normalizedText: text,
        };
    }

    private _buildCanonicalInput(
        candidate: LegacyMemoryBackfillCandidate,
        normalizedText: string,
    ): ProposedMemoryInput {
        const metadata = candidate.metadata ?? {};
        const confidence = typeof metadata['confidence'] === 'number'
            ? Math.max(0, Math.min(1, metadata['confidence'] as number))
            : 0.6;

        const contentStructured = {
            legacy_memory_id: candidate.legacy_memory_id,
            legacy_timestamp: candidate.timestamp,
            legacy_status: candidate.status,
            legacy_metadata: metadata,
        };

        return {
            memory_type: this._safeString(metadata['memory_type'], 'legacy_backfill'),
            subject_type: this._safeString(metadata['subject_type'], 'user'),
            subject_id: this._safeString(metadata['subject_id'], `legacy:${candidate.legacy_memory_id}`),
            content_text: normalizedText,
            content_structured: contentStructured,
            confidence,
            source_kind: 'legacy_backfill',
            source_ref: `legacy:${candidate.legacy_memory_id}`,
        };
    }

    private _safeString(value: unknown, fallback: string): string {
        if (typeof value !== 'string') return fallback;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : fallback;
    }
}
