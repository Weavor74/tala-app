import { describe, expect, it } from 'vitest';
import { RecoveryAnalyticsProjectorService } from '../electron/services/runtime/recovery/RecoveryAnalyticsProjector';
import type { RecoveryHistoryEntry } from '../electron/services/runtime/recovery/RecoveryTypes';

const baseEntry: RecoveryHistoryEntry = {
    historyId: 'h-1',
    timestamp: '2026-04-18T00:00:00.000Z',
    executionId: 'exec-1',
    triggerType: 'workflow_failed',
    decisionType: 'retry',
    reasonCode: 'recovery.retry.timeout',
    origin: 'automatic',
    operatorOverrideApplied: false,
    approvalState: 'not_required',
    outcome: 'executed',
};

describe('RecoveryAnalyticsProjectorService', () => {
    it('aggregates totals and grouped counts deterministically', () => {
        const projector = new RecoveryAnalyticsProjectorService();
        const entries: RecoveryHistoryEntry[] = [
            { ...baseEntry, historyId: 'h-1', decisionType: 'retry', reasonCode: 'recovery.retry.timeout', failureFamily: 'timeout' },
            { ...baseEntry, historyId: 'h-2', decisionType: 'retry', reasonCode: 'recovery.retry.timeout', failureFamily: 'timeout' },
            { ...baseEntry, historyId: 'h-3', decisionType: 'replan', reasonCode: 'recovery.replan.unavailable', failureFamily: 'unavailable' },
            { ...baseEntry, historyId: 'h-4', decisionType: 'degrade_and_continue', reasonCode: 'recovery.degrade.local_only', failureFamily: 'dependency_degraded' },
            { ...baseEntry, historyId: 'h-5', decisionType: 'escalate', reasonCode: 'recovery.escalate.loop_detected', failureFamily: 'unknown' },
            { ...baseEntry, historyId: 'h-6', decisionType: 'stop', reasonCode: 'recovery.stop.no_valid_path', failureFamily: 'unknown' },
            { ...baseEntry, historyId: 'h-7', decisionType: 'stop', reasonCode: 'recovery.stop.operator_forced', operatorOverrideApplied: true, origin: 'operator_override' },
        ];

        const snapshot = projector.buildRecoveryAnalyticsSnapshot(entries);

        expect(snapshot.totals.retries).toBe(2);
        expect(snapshot.totals.replans).toBe(1);
        expect(snapshot.totals.degradedContinues).toBe(1);
        expect(snapshot.totals.escalations).toBe(1);
        expect(snapshot.totals.stops).toBe(2);
        expect(snapshot.totals.overrides).toBe(1);
        expect(snapshot.totals.loopDetections).toBe(1);

        expect(snapshot.topReasonCodes[0]).toEqual({ reasonCode: 'recovery.retry.timeout', count: 2 });
        expect(snapshot.byDecisionType.find((d) => d.decisionType === 'retry')?.count).toBe(2);
        expect(snapshot.byFailureFamily.find((f) => f.failureFamily === 'timeout')?.count).toBe(2);
    });
});
