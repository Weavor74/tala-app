import { RecoveryAnalyticsProjectorService } from './RecoveryAnalyticsProjector';
import type { RecoveryAnalyticsSnapshot, RecoveryHistoryEntry } from './RecoveryTypes';

export class RecoveryHistoryRepositoryService {
    private static _instance: RecoveryHistoryRepositoryService | null = null;

    private readonly _entries: RecoveryHistoryEntry[] = [];
    private readonly _analyticsProjector = new RecoveryAnalyticsProjectorService();

    constructor(private readonly _maxEntries = 500) {}

    public static getInstance(): RecoveryHistoryRepositoryService {
        if (!this._instance) {
            this._instance = new RecoveryHistoryRepositoryService();
        }
        return this._instance;
    }

    async record(entry: RecoveryHistoryEntry): Promise<void> {
        this._entries.push(entry);
        if (this._entries.length > this._maxEntries) {
            this._entries.splice(0, this._entries.length - this._maxEntries);
        }
    }

    async listRecent(limit: number): Promise<RecoveryHistoryEntry[]> {
        return this.listRecentSync(limit);
    }

    listRecentSync(limit: number): RecoveryHistoryEntry[] {
        const safeLimit = Math.max(0, Math.min(limit, this._maxEntries));
        if (safeLimit === 0) return [];
        return this._entries.slice(-safeLimit).reverse();
    }

    async getAnalyticsSnapshot(limit = 200): Promise<RecoveryAnalyticsSnapshot> {
        return this.getAnalyticsSnapshotSync(limit);
    }

    getAnalyticsSnapshotSync(limit = 200): RecoveryAnalyticsSnapshot {
        const entries = this.listRecentSync(limit).slice().reverse();
        return this._analyticsProjector.buildRecoveryAnalyticsSnapshot(entries);
    }

    _resetForTesting(): void {
        this._entries.length = 0;
    }
}
