import { describe, expect, it } from 'vitest';
import { IterationEffectivenessProjectorService } from '../../electron/services/planning/IterationEffectivenessProjector';

function ingestLoop(
    projector: IterationEffectivenessProjectorService,
    loopId: string,
    opts: {
        taskClass: string;
        maxIterations: number;
        observations: Array<'failed' | 'partial' | 'blocked' | 'succeeded'>;
        decisions: Array<'stop' | 'retry_same_plan' | 'replan_then_continue'>;
        improvements?: number[];
        terminal: 'planning.loop_completed' | 'planning.loop_failed' | 'planning.loop_aborted';
        approvalBlocked?: boolean;
        budgetExhausted?: boolean;
    },
): void {
    projector.ingestEvent('planning.loop_iteration_budget_resolved', {
        loopId,
        taskLoopDoctrineClass: opts.taskClass,
        maxIterations: opts.maxIterations,
    });
    opts.observations.forEach((outcome, index) => {
        const iteration = index + 1;
        projector.ingestEvent('planning.loop_iteration_started', { loopId, iteration });
        projector.ingestEvent('planning.loop_observation', { loopId, iteration, outcome });
        projector.ingestEvent('planning.loop_replan_decision', {
            loopId,
            iteration,
            decision: opts.decisions[index] ?? 'stop',
        });
        if (opts.improvements?.includes(iteration)) {
            projector.ingestEvent('planning.loop_iteration_improved_outcome', { loopId, iteration });
        } else if (iteration > 1) {
            projector.ingestEvent('planning.loop_iteration_no_material_improvement', { loopId, iteration });
        }
    });
    if (opts.approvalBlocked) {
        projector.ingestEvent('planning.loop_iteration_blocked_by_policy', {
            loopId,
            blockedByApproval: true,
            blockedByPolicy: false,
        });
    }
    if (opts.budgetExhausted) {
        projector.ingestEvent('planning.loop_iteration_budget_exhausted', { loopId });
    }
    projector.ingestEvent(opts.terminal, { loopId });
}

describe('IterationEffectivenessProjector', () => {
    it('projects depth uplift, diminishing returns, and retry/replan separation', () => {
        const projector = new IterationEffectivenessProjectorService();

        ingestLoop(projector, 'loop-1', {
            taskClass: 'retrieval_summarize_verify',
            maxIterations: 3,
            observations: ['partial', 'succeeded'],
            decisions: ['retry_same_plan', 'stop'],
            improvements: [2],
            terminal: 'planning.loop_completed',
        });

        ingestLoop(projector, 'loop-2', {
            taskClass: 'retrieval_summarize_verify',
            maxIterations: 3,
            observations: ['failed', 'partial', 'partial'],
            decisions: ['replan_then_continue', 'retry_same_plan', 'stop'],
            improvements: [2],
            terminal: 'planning.loop_failed',
            budgetExhausted: true,
        });

        const snapshot = projector.getSnapshot('2026-04-18T00:00:00.000Z');
        const stats = snapshot.taskFamilyStats.find((item) => item.taskClass === 'retrieval_summarize_verify');
        expect(stats).toBeDefined();
        expect(stats?.sampleCount).toBe(2);
        expect(stats?.depthProfiles.find((d) => d.depth === 2)?.marginalGainFromPriorDepth).toBeGreaterThan(0);
        expect(stats?.depthProfiles.find((d) => d.depth === 3)?.marginalGainFromPriorDepth).toBeLessThanOrEqual(0);
        expect(stats?.replan.replanAttempts).toBe(1);
        expect(stats?.retry.retryAttempts).toBe(2);
        expect(stats?.waste.budgetExhaustionCount).toBe(1);
    });

    it('tracks approval-blocked continuation separately from failures', () => {
        const projector = new IterationEffectivenessProjectorService();
        ingestLoop(projector, 'loop-approval', {
            taskClass: 'operator_sensitive',
            maxIterations: 1,
            observations: ['blocked'],
            decisions: ['stop'],
            terminal: 'planning.loop_aborted',
            approvalBlocked: true,
        });
        const snapshot = projector.getSnapshot('2026-04-18T00:00:00.000Z');
        const stats = snapshot.taskFamilyStats.find((item) => item.taskClass === 'operator_sensitive');
        expect(stats?.approvalBlockedCount).toBe(1);
        expect(stats?.blockedCount).toBe(1);
    });
});
