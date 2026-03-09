import { ReflectionQueueService } from './ReflectionQueueService';
import { ReflectionSchedulerState, ReflectionPipelineActivity, ReflectionPipelinePhase, SelfImprovementGoal } from './reflectionEcosystemTypes';
import { GoalService } from './GoalService';
import { ReflectionService } from './ReflectionService';
import { ReflectionJournalService } from './ReflectionJournalService';

export interface SchedulerConfig {
    enabled: boolean;
    tickIntervalMs: number;
    scanIntervalMs: number;
    maxConcurrentJobs: number;
}

export class ReflectionScheduler {
    private queue: ReflectionQueueService;
    private goalService: GoalService;
    private journal: ReflectionJournalService;

    // Weak ref back to service for executing complex logic (or orchestrator)
    private executeQueueItemCallback: (queueItemId: string) => Promise<{ success: boolean; message: string; issueId?: string }>;
    private onActivityUpdated?: (activity: ReflectionPipelineActivity, state: ReflectionSchedulerState) => void;

    private config: SchedulerConfig;
    private actvType: string | undefined;
    private activeQueueItemId: string | undefined;
    private lastTickAt: string | undefined;
    private lastRunSummary: string | undefined;
    private lastError: string | undefined;
    private consecutiveFailures: number = 0;

    private pipelineActivity: ReflectionPipelineActivity = {
        isActive: false,
        currentPhase: 'idle',
        queueDepth: 0,
        queuedGoalCount: 0,
        activeGoalCount: 0,
        proposalsReadyCount: 0,
        validationsRunningCount: 0,
        promotionsPendingCount: 0
    };

    private timer: NodeJS.Timeout | null = null;
    private isTicking: boolean = false;

    constructor(
        queue: ReflectionQueueService,
        goalService: GoalService,
        journal: ReflectionJournalService,
        executeCallback: (queueItemId: string) => Promise<{ success: boolean; message: string; issueId?: string }>,
        onActivityUpdated?: (activity: ReflectionPipelineActivity, state: ReflectionSchedulerState) => void
    ) {
        this.queue = queue;
        this.goalService = goalService;
        this.journal = journal;
        this.executeQueueItemCallback = executeCallback;
        this.onActivityUpdated = onActivityUpdated;

        // Defaults: Tick every 30s. Scans triggered organically inside service or manually.
        this.config = {
            enabled: true,
            tickIntervalMs: 30000,
            scanIntervalMs: 10 * 60000,
            maxConcurrentJobs: 1
        };
    }

    public start() {
        if (!this.config.enabled) return;
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs);
        this.updateActivityPhase('idle');
    }

    public stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    public async enable() {
        this.config.enabled = true;
        this.start();
    }

    public async disable() {
        this.config.enabled = false;
        this.stop();
    }

    public updateActivityPhase(phase: ReflectionPipelinePhase, metadata?: Partial<ReflectionPipelineActivity>) {
        this.pipelineActivity.currentPhase = phase;
        this.pipelineActivity.isActive = phase !== 'idle' && phase !== 'completed' && phase !== 'failed';

        if (metadata) {
            this.pipelineActivity = { ...this.pipelineActivity, ...metadata };
        }

        if (phase === 'idle' || phase === 'completed' || phase === 'failed') {
            this.pipelineActivity.currentQueueItemId = undefined;
            this.pipelineActivity.currentGoalId = undefined;
        }

        console.log(`[ReflectionScheduler] Pipeline Phase Transition -> ${phase}`);
        this.emitActivityUpdate();
    }

    private emitActivityUpdate() {
        if (this.onActivityUpdated) {
            this.onActivityUpdated(this.pipelineActivity, this.getSchedulerState());
        }
    }

    public async getPipelineActivity(): Promise<ReflectionPipelineActivity> {
        // Hydrate counts live
        const queuedItems = await this.queue.listQueued();
        const goals = await this.goalService.listGoals();

        this.pipelineActivity.queueDepth = queuedItems.length;
        this.pipelineActivity.queuedGoalCount = goals.filter(g => g.status === 'queued').length;
        this.pipelineActivity.activeGoalCount = goals.filter(g => g.status === 'active' || g.status === 'analyzing').length;

        return { ...this.pipelineActivity };
    }

    public getSchedulerState(): ReflectionSchedulerState {
        return {
            enabled: this.config.enabled,
            isRunning: this.isTicking,
            lastTickAt: this.lastTickAt,
            nextTickAt: this.timer ? new Date(Date.now() + this.config.tickIntervalMs).toISOString() : undefined,
            activeQueueItemId: this.activeQueueItemId,
            activeRunType: this.actvType,
            queueDepth: this.pipelineActivity.queueDepth,
            queuedGoals: this.pipelineActivity.queuedGoalCount,
            lastRunSummary: this.lastRunSummary,
            lastError: this.lastError,
            consecutiveFailures: this.consecutiveFailures,
            maxConcurrentJobs: this.config.maxConcurrentJobs
        };
    }

    public async tickNow(): Promise<{ success: boolean; message: string; issueId?: string }> {
        if (this.isTicking) return { success: false, message: 'Scheduler is already ticking' };
        return await this.tick();
    }

    // Process the loop safely
    private async tick(): Promise<{ success: boolean; message: string; issueId?: string }> {
        if (this.isTicking || this.pipelineActivity.isActive) {
            return { success: false, message: 'Pipeline is currently active' };
        }

        this.isTicking = true;
        this.lastTickAt = new Date().toISOString();
        let result = { success: false, message: 'No runnable items in queue' };

        try {
            await this.recoverStaleLocks();

            const next = await this.queue.getNextRunnable();
            if (next) {
                result = await this.processQueueItem(next.queueItemId);
            }
        } catch (e: any) {
            console.error(`[ReflectionScheduler] Tick threw error:`, e);
            result = { success: false, message: `Tick error: ${e.message}` };
        } finally {
            this.isTicking = false;
        }

        return result;
    }

    private async recoverStaleLocks() {
        const active = await this.queue.listActive();
        const now = Date.now();
        for (const item of active) {
            if (item.lockExpiresAt && now > item.lockExpiresAt) {
                console.warn(`[ReflectionScheduler] Recovering stale lock for queue item ${item.queueItemId}`);
                await this.queue.markFailed(item.queueItemId, 'Lock expired/stale process crashed');
                this.journal.writeEntry({
                    issueId: 'system_stale_lock',
                    eventType: 'validation_failed',
                    summary: `Recovered stale queue lock on ${item.queueItemId}`,
                    evidence: { item },
                    tags: ['scheduler', 'stale'],
                    confidence: 1
                });
            }
        }
    }

    private async processQueueItem(queueItemId: string): Promise<{ success: boolean; message: string; issueId?: string }> {
        this.updateActivityPhase('queueing', { currentQueueItemId: queueItemId });

        const locked = await this.queue.lockItem(queueItemId, 'scheduler');
        if (!locked) {
            this.updateActivityPhase('idle');
            return { success: false, message: 'Failed to lock queue item' };
        }

        this.activeQueueItemId = queueItemId;
        this.pipelineActivity.startedAt = new Date().toISOString();

        let executionResult: { success: boolean; message: string; issueId?: string };

        try {
            await this.queue.markRunning(queueItemId);

            // Hand off to executing layer (ReflectionService orchestrator)
            executionResult = await this.executeQueueItemCallback(queueItemId);

            if (executionResult.success) {
                await this.queue.markCompleted(queueItemId, executionResult.message, executionResult.issueId);
                this.lastRunSummary = executionResult.message;
                this.consecutiveFailures = 0;
                this.updateActivityPhase('completed', { lastCompletedAt: new Date().toISOString(), lastOutcome: 'success', lastSummary: executionResult.message });
            } else {
                this.lastError = executionResult.message;
                this.consecutiveFailures++;
                await this.queue.markFailed(queueItemId, executionResult.message);
                this.updateActivityPhase('failed', { lastCompletedAt: new Date().toISOString(), lastOutcome: 'failed', lastError: executionResult.message });
            }

        } catch (e: any) {
            executionResult = { success: false, message: e.message };
            this.lastError = e.message;
            this.consecutiveFailures++;
            await this.queue.markFailed(queueItemId, e.message);
            this.updateActivityPhase('failed', { lastCompletedAt: new Date().toISOString(), lastOutcome: 'failed', lastError: e.message });
        } finally {
            this.activeQueueItemId = undefined;
            this.actvType = undefined;
            // return to idle shortly after UI has chance to see 'completed'
            setTimeout(() => {
                if (!this.pipelineActivity.isActive || this.pipelineActivity.currentPhase === 'completed' || this.pipelineActivity.currentPhase === 'failed') {
                    this.updateActivityPhase('idle');
                }
            }, 2000);
        }

        return executionResult;
    }
}
