import { describe, it, expect } from 'vitest';
import { TurnIntentAnalysisService } from '../electron/services/kernel/TurnIntentAnalyzer';
import { TurnArbitrationService } from '../electron/services/kernel/TurnArbitrator';
import type { KernelTurnContext } from '../electron/services/kernel/TurnContextBuilder';

function makeContext(overrides: Partial<KernelTurnContext> = {}): KernelTurnContext {
    return {
        request: {
            turnId: 'turn-1',
            conversationId: 'conv-1',
            userText: 'explain this',
            operatorMode: 'auto',
        },
        normalizedText: 'explain this',
        tokens: ['explain', 'this'],
        hasActiveGoal: false,
        runtime: {
            executionId: 'exec-1',
            origin: 'ipc',
            mode: 'assistant',
        },
        ...overrides,
    };
}

describe('TurnIntentAnalyzer', () => {
    const analyzer = new TurnIntentAnalysisService();

    it('scores explicit build/fix language toward goal execution', () => {
        const ctx = makeContext({
            request: { ...makeContext().request, userText: 'implement this fix now' },
            normalizedText: 'implement this fix now',
            tokens: ['implement', 'this', 'fix', 'now'],
        });
        const profile = analyzer.analyze(ctx);
        expect(profile.containsBuildOrFixRequest).toBe(true);
        expect(profile.goalExecutionWeight).toBeGreaterThan(profile.conversationalWeight);
    });

    it('keeps explanation/review language conversational by default', () => {
        const ctx = makeContext({
            request: { ...makeContext().request, userText: 'review and summarize this change' },
            normalizedText: 'review and summarize this change',
            tokens: ['review', 'and', 'summarize', 'this', 'change'],
        });
        const profile = analyzer.analyze(ctx);
        expect(profile.likelyNeedsOnlyExplanation).toBe(true);
        expect(profile.conversationalWeight).toBeGreaterThan(profile.goalExecutionWeight);
    });

    it('boosts continuity when active goal is referenced', () => {
        const ctx = makeContext({
            request: {
                ...makeContext().request,
                activeGoalId: 'goal-42',
                userText: 'continue this goal and finish remaining steps',
            },
            normalizedText: 'continue this goal and finish remaining steps',
            tokens: ['continue', 'this', 'goal', 'and', 'finish', 'remaining', 'steps'],
            hasActiveGoal: true,
        });
        const profile = analyzer.analyze(ctx);
        expect(profile.referencesActiveWork).toBe(true);
        expect(profile.hybridWeight).toBeGreaterThan(0.4);
    });
});

describe('TurnArbitrator', () => {
    const analyzer = new TurnIntentAnalysisService();
    const arbitrator = new TurnArbitrationService();

    it('operator override chat wins over execution inference', () => {
        const ctx = makeContext({
            request: {
                ...makeContext().request,
                userText: 'implement this change now',
                operatorMode: 'chat',
            },
            normalizedText: 'implement this change now',
            tokens: ['implement', 'this', 'change', 'now'],
        });
        const profile = analyzer.analyze(ctx);
        const { decision } = arbitrator.arbitrate(ctx, profile);
        expect(decision.mode).toBe('conversational');
        expect(decision.source).toBe('operator_override');
    });

    it('routes explicit implementation requests to goal execution', () => {
        const ctx = makeContext({
            request: { ...makeContext().request, userText: 'fix the bug and run tests' },
            normalizedText: 'fix the bug and run tests',
            tokens: ['fix', 'the', 'bug', 'and', 'run', 'tests'],
        });
        const profile = analyzer.analyze(ctx);
        const { decision } = arbitrator.arbitrate(ctx, profile);
        expect(decision.mode).toBe('goal_execution');
        expect(decision.requiresExecutionLoop).toBe(true);
        expect(decision.authorityLevel).toBe('full_authority');
    });

    it('uses hybrid as bridge for active-goal continuity discussion', () => {
        const ctx = makeContext({
            request: {
                ...makeContext().request,
                activeGoalId: 'goal-1',
                userText: 'continue this goal, what should we do next?',
            },
            normalizedText: 'continue this goal, what should we do next?',
            hasActiveGoal: true,
        });
        const profile = analyzer.analyze(ctx);
        const { decision } = arbitrator.arbitrate(ctx, profile);
        expect(decision.mode).toBe('hybrid');
        expect(decision.shouldResumeGoal).toBe(true);
    });
});
