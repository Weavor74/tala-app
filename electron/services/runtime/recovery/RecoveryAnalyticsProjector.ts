import type {
    FailureFamily,
    RecoveryAnalyticsSnapshot,
    RecoveryDecisionType,
    RecoveryHistoryEntry,
} from './RecoveryTypes';

export class RecoveryAnalyticsProjectorService {
    buildRecoveryAnalyticsSnapshot(entries: RecoveryHistoryEntry[]): RecoveryAnalyticsSnapshot {
        const totals = {
            retries: 0,
            replans: 0,
            escalations: 0,
            degradedContinues: 0,
            stops: 0,
            overrides: 0,
            loopDetections: 0,
        };

        const reasonCounts = new Map<string, number>();
        const decisionCounts = new Map<RecoveryDecisionType, number>();
        const familyCounts = new Map<FailureFamily, number>();

        for (const entry of entries) {
            if (entry.decisionType === 'retry') totals.retries += 1;
            if (entry.decisionType === 'replan') totals.replans += 1;
            if (entry.decisionType === 'escalate') totals.escalations += 1;
            if (entry.decisionType === 'degrade_and_continue') totals.degradedContinues += 1;
            if (entry.decisionType === 'stop') totals.stops += 1;
            if (entry.operatorOverrideApplied) totals.overrides += 1;
            if ((entry.reasonCode ?? '').includes('loop')) totals.loopDetections += 1;

            reasonCounts.set(entry.reasonCode, (reasonCounts.get(entry.reasonCode) ?? 0) + 1);
            decisionCounts.set(entry.decisionType, (decisionCounts.get(entry.decisionType) ?? 0) + 1);
            if (entry.failureFamily) {
                familyCounts.set(entry.failureFamily, (familyCounts.get(entry.failureFamily) ?? 0) + 1);
            }
        }

        return {
            totals,
            topReasonCodes: this._sortedCounts(reasonCounts)
                .slice(0, 8)
                .map(([reasonCode, count]) => ({ reasonCode, count })),
            byDecisionType: this._sortedCounts(decisionCounts)
                .map(([decisionType, count]) => ({ decisionType, count })),
            byFailureFamily: this._sortedCounts(familyCounts)
                .map(([failureFamily, count]) => ({ failureFamily, count })),
        };
    }

    private _sortedCounts<T extends string>(map: Map<T, number>): Array<[T, number]> {
        return [...map.entries()].sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return String(a[0]).localeCompare(String(b[0]));
        });
    }
}
