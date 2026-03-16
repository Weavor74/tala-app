/**
 * Memory Contribution Model Tests — Phase 3
 *
 * Validates structured memory categorization, influence policy, and write policy.
 *
 * Coverage:
 * - Memory items are correctly categorized
 * - Per-category limits are enforced
 * - Low-salience memories are excluded
 * - Explicit source memories outrank inferred memories
 * - RP mode applies stricter limits
 * - Write policy resolves correctly per mode and intent
 * - Stale/archived memories do not appear (handled upstream by MemoryFilter)
 */

import { describe, it, expect } from 'vitest';
import { MemoryContributionBuilder } from '../../services/cognitive/MemoryContributionModel';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
    return {
        id: `mem-${Math.random().toString(36).slice(2, 8)}`,
        text: 'Default test memory text',
        timestamp: new Date().toISOString(),
        metadata: {
            type: 'factual',
            source: 'mem0',
            salience: 0.7,
            confidence: 0.8,
        },
        status: 'active',
        ...overrides,
    } as MemoryItem;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryContributionBuilder — categorization', () => {
    it('classifies identity memory correctly', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'identity', source: 'explicit', salience: 0.9, confidence: 0.95 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(1);
        expect(model.contributions[0].category).toBe('identity');
        expect(model.contributions[0].influenceScope).toContain('identity');
        expect(model.contributions[0].influenceScope).toContain('tone');
    });

    it('classifies preference memory correctly', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'user_preference', source: 'mem0', salience: 0.6, confidence: 0.7 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(1);
        expect(model.contributions[0].category).toBe('preference');
        expect(model.contributions[0].influenceScope).toContain('style');
    });

    it('classifies recent continuity memory correctly', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'session', source: 'mem0', salience: 0.5, confidence: 0.7 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(1);
        expect(model.contributions[0].category).toBe('recent_continuity');
    });

    it('classifies task-relevant memory correctly', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'technical', source: 'mem0', salience: 0.7, confidence: 0.8 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(1);
        expect(model.contributions[0].category).toBe('task_relevant');
        expect(model.contributions[0].influenceScope).toContain('task');
    });
});

describe('MemoryContributionBuilder — suppression and filtering', () => {
    it('returns empty contributions when retrieval is suppressed', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory()],
            1, 0, true, 'greeting intent', 'assistant',
        );

        expect(model.contributions.length).toBe(0);
        expect(model.retrievalSuppressed).toBe(true);
        expect(model.suppressionReason).toBe('greeting intent');
    });

    it('excludes memories below salience threshold', () => {
        // task_relevant threshold is 0.4
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'factual', source: 'mem0', salience: 0.1, confidence: 0.9 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(0);
    });

    it('includes identity memory even at lower salience (threshold 0.3)', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory({ metadata: { type: 'identity', source: 'explicit', salience: 0.35, confidence: 0.8 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions.length).toBe(1);
    });

    it('preserves explicit user facts over inferred memories via sorting', () => {
        const inferred = makeMemory({
            text: 'User prefers coffee',
            metadata: { type: 'user_preference', source: 'rag', salience: 0.9, confidence: 0.6 },
        });
        const explicit = makeMemory({
            text: 'User prefers tea',
            metadata: { type: 'user_preference', source: 'explicit', salience: 0.8, confidence: 0.95 },
        });

        const model = MemoryContributionBuilder.build(
            [inferred, explicit],
            2, 0, false, undefined, 'assistant',
        );

        // Both should be included (different items), but explicit should rank first
        const firstContrib = model.contributions[0];
        expect(firstContrib.memoryId).toBe(explicit.id);
    });
});

describe('MemoryContributionBuilder — mode-specific limits', () => {
    it('limits task_relevant contributions in rp mode', () => {
        // RP mode limits task_relevant to 2
        const manyTaskMemories = Array.from({ length: 6 }, () =>
            makeMemory({ metadata: { type: 'technical', source: 'mem0', salience: 0.8, confidence: 0.8 } })
        );

        const model = MemoryContributionBuilder.build(
            manyTaskMemories,
            6, 0, false, undefined, 'rp',
        );

        const taskContribs = model.contributions.filter(c => c.category === 'task_relevant');
        expect(taskContribs.length).toBeLessThanOrEqual(2);
    });

    it('limits identity contributions in rp mode to 1', () => {
        const manyIdentityMemories = Array.from({ length: 4 }, () =>
            makeMemory({ metadata: { type: 'identity', source: 'explicit', salience: 0.9, confidence: 0.9 } })
        );

        const model = MemoryContributionBuilder.build(
            manyIdentityMemories,
            4, 0, false, undefined, 'rp',
        );

        const identityContribs = model.contributions.filter(c => c.category === 'identity');
        expect(identityContribs.length).toBeLessThanOrEqual(1);
    });

    it('allows up to 5 task_relevant contributions in assistant mode', () => {
        const manyTaskMemories = Array.from({ length: 6 }, () =>
            makeMemory({ metadata: { type: 'technical', source: 'mem0', salience: 0.8, confidence: 0.8 } })
        );

        const model = MemoryContributionBuilder.build(
            manyTaskMemories,
            6, 0, false, undefined, 'assistant',
        );

        const taskContribs = model.contributions.filter(c => c.category === 'task_relevant');
        expect(taskContribs.length).toBeLessThanOrEqual(5);
        expect(taskContribs.length).toBeGreaterThan(2);
    });
});

describe('MemoryContributionBuilder — write policy', () => {
    it('resolves do_not_write for rp mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('rp', 'narrative', false);
        expect(result.policy).toBe('do_not_write');
        expect(result.reason).toContain('RP mode');
    });

    it('resolves do_not_write for greeting intent', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'greeting', true);
        expect(result.policy).toBe('do_not_write');
        expect(result.reason).toContain('Greeting');
    });

    it('resolves long_term for technical assistant intent', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'technical', false);
        expect(result.policy).toBe('long_term');
        expect(result.reason).toContain('technical');
    });

    it('resolves short_term for hybrid mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('hybrid', 'conversation', false);
        expect(result.policy).toBe('short_term');
    });

    it('resolves short_term for assistant mode default intent', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'casual', false);
        expect(result.policy).toBe('short_term');
    });

    it('resolves long_term for planning intent in assistant mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'planning', false);
        expect(result.policy).toBe('long_term');
    });
});

describe('MemoryContributionBuilder — metadata preservation', () => {
    it('preserves candidate and excluded counts', () => {
        const model = MemoryContributionBuilder.build(
            [makeMemory()],
            10, 7, false, undefined, 'assistant',
        );

        expect(model.candidateCount).toBe(10);
        expect(model.excludedCount).toBe(7);
    });

    it('includes retrievedAt timestamp', () => {
        const model = MemoryContributionBuilder.build(
            [], 0, 0, false, undefined, 'assistant',
        );

        expect(model.retrievedAt).toBeTruthy();
        expect(() => new Date(model.retrievedAt)).not.toThrow();
    });

    it('truncates summary to 200 chars', () => {
        const longText = 'a'.repeat(300);
        const model = MemoryContributionBuilder.build(
            [makeMemory({ text: longText, metadata: { type: 'factual', source: 'mem0', salience: 0.7, confidence: 0.8 } })],
            1, 0, false, undefined, 'assistant',
        );

        expect(model.contributions[0].summary.length).toBeLessThanOrEqual(200);
    });
});
