import * as fs from 'fs';
import * as path from 'path';
import { ReflectionDataDirectories } from './DataDirectoryPaths';
import { ReflectionQueueItem, ReflectionQueueItemStatus, ReflectionQueueItemType, ReflectionQueueItemSource } from './reflectionEcosystemTypes';

export class ReflectionQueueService {
    private dirs: ReflectionDataDirectories;

    constructor(dirs: ReflectionDataDirectories) {
        this.dirs = dirs;
    }

    private getQueueFile(): string {
        return path.join(this.dirs.queueDir, 'reflection-queue.jsonl');
    }

    private readAll(): ReflectionQueueItem[] {
        const p = this.getQueueFile();
        if (!fs.existsSync(p)) return [];
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim().length > 0);
        return lines.map(l => {
            try { return JSON.parse(l); }
            catch (e) { return null; }
        }).filter(Boolean);
    }

    private writeAll(items: ReflectionQueueItem[]) {
        const p = this.getQueueFile();
        const content = items.map(i => JSON.stringify(i)).join('\n') + '\n';
        fs.writeFileSync(p, content, 'utf8');
    }

    public async listQueued(): Promise<ReflectionQueueItem[]> {
        return this.readAll().filter(i => i.status === 'queued');
    }

    public async listActive(): Promise<ReflectionQueueItem[]> {
        return this.readAll().filter(i => i.status === 'locked' || i.status === 'running');
    }

    public async listAll(): Promise<ReflectionQueueItem[]> {
        return this.readAll();
    }

    public async enqueue(
        itemInput: Omit<ReflectionQueueItem, 'queueItemId' | 'createdAt' | 'updatedAt' | 'status' | 'attemptCount'>
    ): Promise<ReflectionQueueItem | null> {
        const allItems = this.readAll();

        // Deduplication rule: If manual goal execution or goal, check if already active/queued
        if (itemInput.goalId && ['goal', 'manual_goal_execution'].includes(itemInput.type)) {
            const existing = allItems.find(i =>
                i.goalId === itemInput.goalId &&
                (i.status === 'queued' || i.status === 'locked' || i.status === 'running')
            );
            if (existing) {
                console.log(`[ReflectionQueue] Blocking enqueue of duplicate active goal ${itemInput.goalId}`);
                return null;
            }
        }

        // Deduplication for manual scans if one is already running/queued recently
        if (itemInput.type === 'manual_scan') {
            const existingScan = allItems.find(i => i.type === 'manual_scan' && (i.status === 'queued' || i.status === 'locked' || i.status === 'running'));
            if (existingScan) {
                console.log(`[ReflectionQueue] Blocking duplicate manual scan.`);
                return null;
            }
        }

        const newItem: ReflectionQueueItem = {
            queueItemId: `rq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'queued',
            attemptCount: 0,
            ...itemInput
        };

        allItems.push(newItem);
        this.writeAll(allItems);

        return newItem;
    }

    public async getNextRunnable(): Promise<ReflectionQueueItem | null> {
        const queued = await this.listQueued();
        if (queued.length === 0) return null;

        // Sort by priority then by oldest
        const prioMap: Record<string, number> = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
        queued.sort((a, b) => {
            const pDiff = prioMap[b.priority] - prioMap[a.priority];
            if (pDiff !== 0) return pDiff;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        return queued[0];
    }

    public async lockItem(queueItemId: string, owner: string): Promise<boolean> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (!item) return false;

        // Ensure we don't double lock unless the lock expired
        if (item.status === 'locked' || item.status === 'running') {
            if (item.lockExpiresAt && Date.now() < item.lockExpiresAt) {
                return false;
            }
        }

        item.status = 'locked';
        item.lockedBy = owner;
        item.lockExpiresAt = Date.now() + (1000 * 60 * 30); // 30 min lock
        item.updatedAt = new Date().toISOString();

        this.writeAll(items);
        return true;
    }

    public async markRunning(queueItemId: string): Promise<void> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (item) {
            item.status = 'running';
            item.startedAt = new Date().toISOString();
            item.updatedAt = new Date().toISOString();
            item.attemptCount++;
            this.writeAll(items);
        }
    }

    public async markCompleted(queueItemId: string, resultSummary: string, issueId?: string): Promise<void> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (item) {
            item.status = 'completed';
            item.completedAt = new Date().toISOString();
            item.updatedAt = new Date().toISOString();
            item.resultSummary = resultSummary;
            if (issueId) item.issueId = issueId;
            item.lockedBy = undefined;
            item.lockExpiresAt = undefined;
            this.writeAll(items);
        }
    }

    public async markFailed(queueItemId: string, error: string): Promise<void> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (item) {
            item.status = 'failed';
            item.lastError = error;
            item.completedAt = new Date().toISOString();
            item.updatedAt = new Date().toISOString();
            item.lockedBy = undefined;
            item.lockExpiresAt = undefined;
            this.writeAll(items);
        }
    }

    public async cancelItem(queueItemId: string): Promise<boolean> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (item && item.status === 'queued') {
            item.status = 'cancelled';
            item.updatedAt = new Date().toISOString();
            this.writeAll(items);
            return true;
        }
        return false;
    }

    public async retryItem(queueItemId: string): Promise<boolean> {
        const items = this.readAll();
        const item = items.find(i => i.queueItemId === queueItemId);
        if (item && (item.status === 'failed' || item.status === 'cancelled')) {
            item.status = 'queued';
            item.updatedAt = new Date().toISOString();
            item.lastError = undefined;
            this.writeAll(items);
            return true;
        }
        return false;
    }
}
