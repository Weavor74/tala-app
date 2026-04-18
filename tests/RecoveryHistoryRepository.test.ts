import { beforeEach, describe, expect, it } from 'vitest';
import { RecoveryHistoryRepositoryService } from '../electron/services/runtime/recovery/RecoveryHistoryRepository';
import type { RecoveryHistoryEntry } from '../electron/services/runtime/recovery/RecoveryTypes';

function makeEntry(id: string, timestamp: string): RecoveryHistoryEntry {
    return {
        historyId: id,
        timestamp,
        executionId: 'exec-hist',
        executionBoundaryId: 'boundary-hist',
        triggerType: 'workflow_failed',
        decisionType: 'retry',
        reasonCode: 'recovery.retry.timeout',
        scope: 'execution_boundary',
        failureFamily: 'timeout',
        origin: 'automatic',
        operatorOverrideApplied: false,
        approvalState: 'not_required',
        outcome: 'executed',
    };
}

describe('RecoveryHistoryRepositoryService', () => {
    const repository = RecoveryHistoryRepositoryService.getInstance();

    beforeEach(() => {
        repository._resetForTesting();
    });

    it('records entries and preserves required fields', async () => {
        const entry = makeEntry('hist-1', '2026-04-18T01:00:00.000Z');
        await repository.record(entry);

        const recent = await repository.listRecent(10);
        expect(recent).toHaveLength(1);
        expect(recent[0]).toMatchObject(entry);
    });

    it('returns recent entries in reverse chronological insertion order', async () => {
        await repository.record(makeEntry('hist-1', '2026-04-18T01:00:00.000Z'));
        await repository.record(makeEntry('hist-2', '2026-04-18T01:01:00.000Z'));
        await repository.record(makeEntry('hist-3', '2026-04-18T01:02:00.000Z'));

        const recent = repository.listRecentSync(2);
        expect(recent.map((r) => r.historyId)).toEqual(['hist-3', 'hist-2']);
    });

    it('projects analytics from recorded history', async () => {
        await repository.record(makeEntry('hist-1', '2026-04-18T01:00:00.000Z'));
        await repository.record({
            ...makeEntry('hist-2', '2026-04-18T01:01:00.000Z'),
            decisionType: 'replan',
            reasonCode: 'recovery.replan.unavailable',
            failureFamily: 'unavailable',
        });

        const analytics = await repository.getAnalyticsSnapshot();
        expect(analytics.totals.retries).toBe(1);
        expect(analytics.totals.replans).toBe(1);
        expect(analytics.topReasonCodes.length).toBeGreaterThan(0);
    });
});
