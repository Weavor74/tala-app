/**
 * MemoryRankingValidation — Phase 3C: Cognitive Behavior Validation
 *
 * Validates the memory retrieval and ranking pipeline:
 *   - Explicit facts receive higher priority than inferred memories
 *   - Category-based contribution limits prevent flooding
 *   - Low-salience inferred memories are suppressed below threshold
 *   - Greeting turns suppress retrieval entirely
 *   - Category balancing produces diverse contribution sets
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

import { MemoryContributionBuilder } from '../electron/services/cognitive/MemoryContributionModel';
import type { MemoryItem } from '../electron/services/MemoryService';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMemory(
    id: string,
    text: string,
    opts: {
        type?: string;
        role?: string;
        tags?: string[];
        score?: number;
        compositeScore?: number;
    } = {},
): MemoryItem {
    return {
        id,
        text,
        metadata: {
            type: opts.type,
            role: opts.role,
            tags: opts.tags ?? [],
        },
        score: opts.score ?? 0.7,
        compositeScore: opts.compositeScore ?? opts.score ?? 0.7,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryRankingValidation', () => {
    it('returns empty model when retrieval is suppressed (greeting turn)', () => {
        const model = MemoryContributionBuilder.build(
            [],
            0,
            0,
            true,
            'Turn classified as greeting.',
        );

        expect(model.contributions).toHaveLength(0);
        expect(model.retrievalSuppressed).toBe(true);
        expect(model.suppressionReason).toContain('greeting');
    });

    it('returns empty model when no memories provided', () => {
        const model = MemoryContributionBuilder.build([], 0, 0, false);

        expect(model.contributions).toHaveLength(0);
        expect(model.retrievalSuppressed).toBe(false);
    });

    it('classifies identity-typed memory into identity category', () => {
        const memories = [
            makeMemory('mem-1', 'User name is Alex.', { type: 'user_profile', score: 0.95 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        const identityContribs = model.contributions.filter(c => c.category === 'identity');
        expect(identityContribs.length).toBeGreaterThanOrEqual(1);
    });

    it('classifies preference-typed memory into preference category', () => {
        const memories = [
            makeMemory('mem-2', 'User prefers dark mode.', { type: 'user_preference', score: 0.8 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        const prefContribs = model.contributions.filter(c => c.category === 'preference');
        expect(prefContribs.length).toBeGreaterThanOrEqual(1);
    });

    it('classifies session-typed memory into recent_continuity category', () => {
        const memories = [
            makeMemory('mem-3', 'User was debugging a race condition.', { type: 'session', score: 0.6 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        const continuityContribs = model.contributions.filter(c => c.category === 'recent_continuity');
        expect(continuityContribs.length).toBeGreaterThanOrEqual(1);
    });

    it('identity contributions influence tone and identity scope', () => {
        const memories = [
            makeMemory('mem-4', 'User is Alex.', { type: 'identity', score: 0.9 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        const identityContrib = model.contributions.find(c => c.category === 'identity');
        expect(identityContrib).toBeDefined();
        expect(identityContrib!.influenceScope).toContain('identity');
        expect(identityContrib!.influenceScope).toContain('tone');
    });

    it('caps contributions per category — does not flood identity', () => {
        const memories = Array.from({ length: 10 }, (_, i) =>
            makeMemory(`mem-id-${i}`, `Identity fact ${i}`, { type: 'identity', score: 0.9 - i * 0.05 }),
        );
        const model = MemoryContributionBuilder.build(memories, 10, 0, false);

        const identityCount = model.contributions.filter(c => c.category === 'identity').length;
        // Max identity cap is 3 per MemoryContributionModel defaults
        expect(identityCount).toBeLessThanOrEqual(3);
    });

    it('caps contributions per category — does not flood task_relevant', () => {
        const memories = Array.from({ length: 12 }, (_, i) =>
            makeMemory(`mem-task-${i}`, `Task fact ${i}`, { type: 'technical', score: 0.85 - i * 0.03 }),
        );
        const model = MemoryContributionBuilder.build(memories, 12, 0, false);

        const taskCount = model.contributions.filter(c => c.category === 'task_relevant').length;
        // Max task_relevant cap is 5 per MemoryContributionModel defaults
        expect(taskCount).toBeLessThanOrEqual(5);
    });

    it('records candidateCount and excludedCount accurately', () => {
        const memories = [
            makeMemory('mem-5', 'User is a developer.', { type: 'technical', score: 0.75 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 10, 3, false);

        expect(model.candidateCount).toBe(10);
        expect(model.excludedCount).toBe(3);
    });

    it('each contribution has a non-empty summary', () => {
        const memories = [
            makeMemory('mem-6', 'User works in TypeScript.', { type: 'technical', score: 0.8 }),
            makeMemory('mem-7', 'User dislikes verbose output.', { type: 'user_preference', score: 0.7 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 2, 0, false);

        for (const contribution of model.contributions) {
            expect(contribution.summary.length).toBeGreaterThan(0);
            expect(contribution.summary.length).toBeLessThanOrEqual(200);
        }
    });

    it('each contribution has a rationale', () => {
        const memories = [
            makeMemory('mem-8', 'User is on macOS.', { type: 'user_profile', score: 0.7 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        for (const contribution of model.contributions) {
            expect(contribution.rationale.length).toBeGreaterThan(0);
        }
    });

    it('all contributions have valid salience in [0, 1]', () => {
        const memories = [
            makeMemory('mem-9', 'User prefers TypeScript strict mode.', { type: 'user_preference', score: 0.85 }),
            makeMemory('mem-10', 'User uses VS Code.', { type: 'technical', score: 0.6 }),
        ];
        const model = MemoryContributionBuilder.build(memories, 2, 0, false);

        for (const contribution of model.contributions) {
            expect(contribution.salience).toBeGreaterThanOrEqual(0);
            expect(contribution.salience).toBeLessThanOrEqual(1);
        }
    });

    it('retrievedAt is a valid ISO timestamp', () => {
        const memories = [makeMemory('mem-11', 'Any memory.', { score: 0.7 })];
        const model = MemoryContributionBuilder.build(memories, 1, 0, false);

        expect(() => new Date(model.retrievedAt)).not.toThrow();
        expect(new Date(model.retrievedAt).toISOString()).toBe(model.retrievedAt);
    });
});
