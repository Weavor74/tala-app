import type {
    IterationDepthSuccessProfile,
    IterationEffectivenessSnapshot,
    IterationTaskFamilyStats,
    ReplanEffectivenessProfile,
    RetryEffectivenessProfile,
    IterationWasteProfile,
} from '../../../shared/planning/IterationEffectivenessTypes';
import type { RuntimeEventType } from '../../../shared/runtimeEventTypes';
import type { IterationWorthinessClass } from '../../../shared/planning/IterationPolicyTypes';

interface LoopIterationRecord {
    iteration: number;
    outcome?: 'succeeded' | 'failed' | 'partial' | 'blocked';
    improved?: boolean;
    decisionAction?: 'stop' | 'retry_same_plan' | 'replan_then_continue';
}

interface LoopTrackingRecord {
    loopId: string;
    taskClass: IterationWorthinessClass;
    maxIterations: number;
    startedIterations: number;
    budgetExhausted: boolean;
    approvalBlocked: boolean;
    terminal?: 'completed' | 'failed' | 'aborted';
    iterations: Map<number, LoopIterationRecord>;
}

interface MutableTaskStats {
    sampleCount: number;
    completedCount: number;
    failedCount: number;
    blockedCount: number;
    partialCount: number;
    approvalBlockedCount: number;
    budgetExhaustionCount: number;
    earlyStopCorrectCount: number;
    totalIterationsUsed: number;
    reachedDepthCounts: Record<number, number>;
    successfulByDepthCounts: Record<number, number>;
    improvedByDepthCounts: Record<number, number>;
    nonImprovingByDepthCounts: Record<number, number>;
    replanAttempts: number;
    replanImproved: number;
    replanWorsened: number;
    replanUnchanged: number;
    retryAttempts: number;
    retryImproved: number;
    retryWorsened: number;
    retryUnchanged: number;
}

const KNOWN_TASK_CLASSES: IterationWorthinessClass[] = [
    'conversational_explanation',
    'retrieval_summarize',
    'retrieval_summarize_verify',
    'notebook_synthesis',
    'artifact_assembly',
    'tool_multistep',
    'workflow_execution',
    'recovery_repair',
    'autonomous_maintenance',
    'operator_sensitive',
    'general_goal_execution',
];

function makeMutableTaskStats(): MutableTaskStats {
    return {
        sampleCount: 0,
        completedCount: 0,
        failedCount: 0,
        blockedCount: 0,
        partialCount: 0,
        approvalBlockedCount: 0,
        budgetExhaustionCount: 0,
        earlyStopCorrectCount: 0,
        totalIterationsUsed: 0,
        reachedDepthCounts: {},
        successfulByDepthCounts: {},
        improvedByDepthCounts: {},
        nonImprovingByDepthCounts: {},
        replanAttempts: 0,
        replanImproved: 0,
        replanWorsened: 0,
        replanUnchanged: 0,
        retryAttempts: 0,
        retryImproved: 0,
        retryWorsened: 0,
        retryUnchanged: 0,
    };
}

function outcomeRank(outcome: LoopIterationRecord['outcome']): number {
    if (outcome === 'failed') return 0;
    if (outcome === 'blocked') return 1;
    if (outcome === 'partial') return 2;
    if (outcome === 'succeeded') return 3;
    return 0;
}

function toRate(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    return numerator / denominator;
}

function clampDepth(depth: number): number {
    if (!Number.isFinite(depth) || depth < 1) return 1;
    if (depth > 3) return 3;
    return Math.floor(depth);
}

export class IterationEffectivenessProjectorService {
    private readonly _loopRecords = new Map<string, LoopTrackingRecord>();
    private readonly _statsByTask = new Map<IterationWorthinessClass, MutableTaskStats>();
    private _totalLoopsObserved = 0;

    ingestEvent(event: RuntimeEventType, payload?: Record<string, unknown>): void {
        if (!payload) return;
        if (!String(event).startsWith('planning.loop_')) return;
        const loopId = typeof payload.loopId === 'string' ? payload.loopId : undefined;
        if (!loopId) return;

        if (event === 'planning.loop_iteration_budget_resolved') {
            const taskClass = this._normalizeTaskClass(payload.taskLoopDoctrineClass);
            const maxIterations = typeof payload.maxIterations === 'number' ? payload.maxIterations : 1;
            this._loopRecords.set(loopId, {
                loopId,
                taskClass,
                maxIterations: clampDepth(maxIterations),
                startedIterations: 0,
                budgetExhausted: false,
                approvalBlocked: false,
                iterations: new Map<number, LoopIterationRecord>(),
            });
            return;
        }

        const record = this._loopRecords.get(loopId);
        if (!record) return;

        if (event === 'planning.loop_iteration_started') {
            const iteration = clampDepth(Number(payload.iteration ?? 1));
            record.startedIterations = Math.max(record.startedIterations, iteration);
            const current = record.iterations.get(iteration) ?? { iteration };
            record.iterations.set(iteration, current);
            return;
        }

        if (event === 'planning.loop_observation') {
            const iteration = clampDepth(Number(payload.iteration ?? 1));
            const outcome = this._normalizeOutcome(payload.outcome);
            const current = record.iterations.get(iteration) ?? { iteration };
            current.outcome = outcome;
            record.iterations.set(iteration, current);
            return;
        }

        if (event === 'planning.loop_replan_decision') {
            const iteration = clampDepth(Number(payload.iteration ?? 1));
            const action = this._normalizeDecisionAction(payload.decision);
            const current = record.iterations.get(iteration) ?? { iteration };
            current.decisionAction = action;
            record.iterations.set(iteration, current);
            return;
        }

        if (event === 'planning.loop_iteration_improved_outcome' || event === 'planning.loop_iteration_no_material_improvement') {
            const iteration = clampDepth(Number(payload.iteration ?? 1));
            const current = record.iterations.get(iteration) ?? { iteration };
            current.improved = event === 'planning.loop_iteration_improved_outcome';
            record.iterations.set(iteration, current);
            return;
        }

        if (event === 'planning.loop_iteration_budget_exhausted') {
            record.budgetExhausted = true;
            return;
        }

        if (event === 'planning.loop_iteration_blocked_by_policy') {
            if (payload.blockedByApproval === true) {
                record.approvalBlocked = true;
            }
            return;
        }

        if (event === 'planning.loop_completed' || event === 'planning.loop_failed' || event === 'planning.loop_aborted') {
            record.terminal = event === 'planning.loop_completed'
                ? 'completed'
                : event === 'planning.loop_failed'
                    ? 'failed'
                    : 'aborted';
            this._finalizeLoop(record);
            this._loopRecords.delete(loopId);
        }
    }

    getSnapshot(now: string = new Date().toISOString()): IterationEffectivenessSnapshot {
        const taskFamilyStats = KNOWN_TASK_CLASSES.map((taskClass) => {
            const mutable = this._statsByTask.get(taskClass) ?? makeMutableTaskStats();
            return this._toTaskFamilyStats(taskClass, mutable);
        }).filter((item) => item.sampleCount > 0);

        return {
            generatedAt: now,
            totalLoopsObserved: this._totalLoopsObserved,
            taskFamilyStats,
        };
    }

    private _finalizeLoop(record: LoopTrackingRecord): void {
        const mutable = this._statsByTask.get(record.taskClass) ?? makeMutableTaskStats();
        const iterations = [...record.iterations.values()].sort((a, b) => a.iteration - b.iteration);
        const iterationsUsed = Math.max(1, record.startedIterations || iterations.length || 1);
        const terminalOutcome = iterations[iterations.length - 1]?.outcome;

        mutable.sampleCount += 1;
        mutable.totalIterationsUsed += iterationsUsed;
        if (record.terminal === 'completed') mutable.completedCount += 1;
        if (record.terminal === 'failed') mutable.failedCount += 1;
        if (record.terminal === 'aborted') mutable.blockedCount += 1;
        if (terminalOutcome === 'partial') mutable.partialCount += 1;
        if (record.approvalBlocked) mutable.approvalBlockedCount += 1;
        if (record.budgetExhausted) mutable.budgetExhaustionCount += 1;
        if (record.terminal === 'completed' && iterationsUsed < record.maxIterations) {
            mutable.earlyStopCorrectCount += 1;
        }

        for (let depth = 1; depth <= 3; depth += 1) {
            if (iterationsUsed >= depth) {
                mutable.reachedDepthCounts[depth] = (mutable.reachedDepthCounts[depth] ?? 0) + 1;
            }
            if (record.terminal === 'completed' && iterationsUsed <= depth) {
                mutable.successfulByDepthCounts[depth] = (mutable.successfulByDepthCounts[depth] ?? 0) + 1;
            }
        }

        for (const iteration of iterations) {
            if (iteration.iteration <= 1) continue;
            if (iteration.improved === true) {
                mutable.improvedByDepthCounts[iteration.iteration] = (mutable.improvedByDepthCounts[iteration.iteration] ?? 0) + 1;
            } else {
                mutable.nonImprovingByDepthCounts[iteration.iteration] = (mutable.nonImprovingByDepthCounts[iteration.iteration] ?? 0) + 1;
            }
        }

        for (const iteration of iterations) {
            if (!iteration.decisionAction || iteration.iteration < 1) continue;
            const next = iterations.find((entry) => entry.iteration === iteration.iteration + 1);
            if (!next) continue;
            const delta = outcomeRank(next.outcome) - outcomeRank(iteration.outcome);
            if (iteration.decisionAction === 'replan_then_continue') {
                mutable.replanAttempts += 1;
                if (delta > 0) mutable.replanImproved += 1;
                else if (delta < 0) mutable.replanWorsened += 1;
                else mutable.replanUnchanged += 1;
            } else if (iteration.decisionAction === 'retry_same_plan') {
                mutable.retryAttempts += 1;
                if (delta > 0) mutable.retryImproved += 1;
                else if (delta < 0) mutable.retryWorsened += 1;
                else mutable.retryUnchanged += 1;
            }
        }

        this._statsByTask.set(record.taskClass, mutable);
        this._totalLoopsObserved += 1;
    }

    private _toTaskFamilyStats(taskClass: IterationWorthinessClass, mutable: MutableTaskStats): IterationTaskFamilyStats {
        const depthProfiles: IterationDepthSuccessProfile[] = [];
        let priorSuccessRate = 0;
        const sampleCount = Math.max(1, mutable.sampleCount);
        for (let depth = 1; depth <= 3; depth += 1) {
            const reached = mutable.reachedDepthCounts[depth] ?? 0;
            const successfulByDepth = mutable.successfulByDepthCounts[depth] ?? 0;
            const successRate = toRate(successfulByDepth, sampleCount);
            const improved = mutable.improvedByDepthCounts[depth] ?? 0;
            const nonImproving = mutable.nonImprovingByDepthCounts[depth] ?? 0;
            const followupCount = improved + nonImproving;
            const wastedRateAtDepth = toRate(nonImproving, followupCount);
            depthProfiles.push({
                depth,
                loopsReachedDepth: reached,
                successfulByDepth,
                successRate,
                marginalGainFromPriorDepth: successRate - priorSuccessRate,
                wastedRateAtDepth,
            });
            priorSuccessRate = successRate;
        }

        const replan: ReplanEffectivenessProfile = {
            replanAttempts: mutable.replanAttempts,
            improvedAfterReplan: mutable.replanImproved,
            worsenedAfterReplan: mutable.replanWorsened,
            unchangedAfterReplan: mutable.replanUnchanged,
            improvementRate: toRate(mutable.replanImproved, mutable.replanAttempts),
            worsenedRate: toRate(mutable.replanWorsened, mutable.replanAttempts),
        };
        const retry: RetryEffectivenessProfile = {
            retryAttempts: mutable.retryAttempts,
            improvedAfterRetry: mutable.retryImproved,
            worsenedAfterRetry: mutable.retryWorsened,
            unchangedAfterRetry: mutable.retryUnchanged,
            improvementRate: toRate(mutable.retryImproved, mutable.retryAttempts),
            worsenedRate: toRate(mutable.retryWorsened, mutable.retryAttempts),
        };
        const waste: IterationWasteProfile = {
            nonImprovingIterations: Object.values(mutable.nonImprovingByDepthCounts).reduce((sum, value) => sum + value, 0),
            totalFollowupIterations:
                Object.values(mutable.nonImprovingByDepthCounts).reduce((sum, value) => sum + value, 0) +
                Object.values(mutable.improvedByDepthCounts).reduce((sum, value) => sum + value, 0),
            wastedIterationRate: 0,
            budgetExhaustionCount: mutable.budgetExhaustionCount,
            budgetExhaustionRate: toRate(mutable.budgetExhaustionCount, mutable.sampleCount),
        };
        waste.wastedIterationRate = toRate(waste.nonImprovingIterations, waste.totalFollowupIterations);

        return {
            taskClass,
            sampleCount: mutable.sampleCount,
            completedCount: mutable.completedCount,
            failedCount: mutable.failedCount,
            blockedCount: mutable.blockedCount,
            partialCount: mutable.partialCount,
            approvalBlockedCount: mutable.approvalBlockedCount,
            earlyStopCorrectCount: mutable.earlyStopCorrectCount,
            averageIterationsUsed: toRate(mutable.totalIterationsUsed, mutable.sampleCount),
            depthProfiles,
            replan,
            retry,
            waste,
        };
    }

    private _normalizeTaskClass(value: unknown): IterationWorthinessClass {
        const candidate = typeof value === 'string' ? value : '';
        if (KNOWN_TASK_CLASSES.includes(candidate as IterationWorthinessClass)) {
            return candidate as IterationWorthinessClass;
        }
        return 'general_goal_execution';
    }

    private _normalizeOutcome(value: unknown): LoopIterationRecord['outcome'] {
        if (value === 'succeeded' || value === 'failed' || value === 'partial' || value === 'blocked') {
            return value;
        }
        return 'failed';
    }

    private _normalizeDecisionAction(value: unknown): LoopIterationRecord['decisionAction'] {
        if (value === 'stop' || value === 'retry_same_plan' || value === 'replan_then_continue') {
            return value;
        }
        return 'stop';
    }
}
