/**
 * Memory Ranking Validation Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective B):
 * - Explicit user facts always outrank inferred memories of the same category
 * - Memory contribution ranking follows: explicit > high-confidence > salience
 * - Low-confidence inferred memories are suppressed
 * - Old/low-salience memories are ranked lower
 * - Memory category counts and diagnostics are correct
 */

import { describe, it, expect } from 'vitest';
import { MemoryContributionBuilder } from '../../services/cognitive/MemoryContributionModel';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryItem(
    id: string,
    text: string,
    overrides: {
        source?: string;
        salience?: number;
        confidence?: number;
        type?: string;
        tags?: string[];
    } = {},
): MemoryItem {
    return {
        id,
        text,
        metadata: {
            source: overrides.source ?? 'inferred',
            salience: overrides.salience ?? 0.5,
            confidence: overrides.confidence ?? 0.7,
            type: overrides.type,
            tags: overrides.tags ?? [],
        },
    } as MemoryItem;
}

// ─── Tests: Explicit fact override ───────────────────────────────────────────

describe('MemoryContributionBuilder — explicit fact override (Objective B)', () => {
    it('explicit user fact outranks an inferred memory with higher salience', () => {
        const explicitFact = makeMemoryItem('explicit-1', 'User is a software engineer.', {
            source: 'explicit',
            salience: 0.5,
            confidence: 0.9,
            type: 'user_profile',
        });
        const inferredFact = makeMemoryItem('inferred-1', 'User may work in tech based on conversation.', {
            source: 'inferred',
            salience: 0.95, // higher salience than explicit fact
            confidence: 0.6,
            type: 'user_profile',
        });

        const model = MemoryContributionBuilder.build(
            [inferredFact, explicitFact], // inferred first in input
            2,
            0,
            false,
            undefined,
            'assistant',
        );

        expect(model.contributions.length).toBeGreaterThanOrEqual(1);
        // The explicit fact must be listed before the inferred fact
        const explicitIdx = model.contributions.findIndex(c => c.memoryId === 'explicit-1');
        const inferredIdx = model.contributions.findIndex(c => c.memoryId === 'inferred-1');
        if (explicitIdx !== -1 && inferredIdx !== -1) {
            expect(explicitIdx).toBeLessThan(inferredIdx);
        }
    });

    it('explicit fact is never ranked below an inferred fact of the same category', () => {
        const memories = [
            makeMemoryItem('m-inferred-a', 'User might prefer dark mode.', {
                source: 'inferred', salience: 0.99, confidence: 0.8, type: 'user_preference',
            }),
            makeMemoryItem('m-inferred-b', 'User probably prefers TypeScript.', {
                source: 'inferred', salience: 0.95, confidence: 0.85, type: 'user_preference',
            }),
            makeMemoryItem('m-explicit', 'User explicitly said they prefer React.', {
                source: 'explicit', salience: 0.5, confidence: 0.95, type: 'user_preference',
            }),
        ];

        const model = MemoryContributionBuilder.build(memories, 3, 0, false, undefined, 'assistant');

        const explicitIdx = model.contributions.findIndex(c => c.memoryId === 'm-explicit');
        const highSalienceInferredIdx = model.contributions.findIndex(c => c.memoryId === 'm-inferred-a');

        // Explicit fact must rank before any inferred fact
        if (explicitIdx !== -1 && highSalienceInferredIdx !== -1) {
            expect(explicitIdx).toBeLessThan(highSalienceInferredIdx);
        }
        // Explicit fact must be present
        expect(explicitIdx).toBeGreaterThanOrEqual(0);
    });

    it('when user explicitly states X, that always wins over inferred Y (same category)', () => {
        // Simulates: user explicitly states they are a teacher (X)
        // while a previous inferred memory says they are a programmer (Y)
        const explicitX = makeMemoryItem('fact-teacher', 'I am a teacher.', {
            source: 'explicit',
            salience: 0.6,
            confidence: 1.0,
            type: 'user_profile',
        });
        const inferredY = makeMemoryItem('inferred-programmer', 'User appears to be a programmer.', {
            source: 'inferred',
            salience: 0.8,
            confidence: 0.7,
            type: 'user_profile',
        });

        const model = MemoryContributionBuilder.build(
            [inferredY, explicitX],
            2,
            0,
            false,
            undefined,
            'assistant',
        );

        const xIdx = model.contributions.findIndex(c => c.memoryId === 'fact-teacher');
        const yIdx = model.contributions.findIndex(c => c.memoryId === 'inferred-programmer');

        expect(xIdx).toBeGreaterThanOrEqual(0);
        if (xIdx !== -1 && yIdx !== -1) {
            expect(xIdx).toBeLessThan(yIdx);
        }
    });
});

// ─── Tests: Low confidence suppression ───────────────────────────────────────

describe('MemoryContributionBuilder — low confidence suppression', () => {
    it('suppresses inferred memories with confidence below 0.3', () => {
        const lowConfidence = makeMemoryItem('low-conf', 'User might occasionally use Python.', {
            source: 'inferred',
            salience: 0.7,
            confidence: 0.2, // below 0.3 threshold
        });
        const normalConfidence = makeMemoryItem('normal-conf', 'User works in software.', {
            source: 'inferred',
            salience: 0.7,
            confidence: 0.5,
        });

        const model = MemoryContributionBuilder.build(
            [lowConfidence, normalConfidence],
            2,
            0,
            false,
            undefined,
            'assistant',
        );

        expect(model.contributions.find(c => c.memoryId === 'low-conf')).toBeUndefined();
        expect(model.contributions.find(c => c.memoryId === 'normal-conf')).toBeDefined();
    });

    it('does NOT suppress explicit facts even if confidence is low', () => {
        const lowConfidenceExplicit = makeMemoryItem('explicit-low-conf', 'User said: I am a writer.', {
            source: 'explicit',
            salience: 0.5,
            confidence: 0.2, // below 0.3 threshold but explicit
        });

        const model = MemoryContributionBuilder.build(
            [lowConfidenceExplicit],
            1,
            0,
            false,
            undefined,
            'assistant',
        );

        expect(model.contributions.find(c => c.memoryId === 'explicit-low-conf')).toBeDefined();
    });
});

// ─── Tests: Salience threshold enforcement ────────────────────────────────────

describe('MemoryContributionBuilder — salience threshold', () => {
    it('excludes inferred memories below minimum salience threshold', () => {
        const lowSalience = makeMemoryItem('low-sal', 'Vague user context.', {
            source: 'inferred',
            salience: 0.1, // below min salience for task_relevant (0.4)
            confidence: 0.8,
        });

        const model = MemoryContributionBuilder.build(
            [lowSalience],
            1,
            0,
            false,
            undefined,
            'assistant',
        );

        expect(model.contributions.find(c => c.memoryId === 'low-sal')).toBeUndefined();
    });
});

// ─── Tests: Category counts ───────────────────────────────────────────────────

describe('MemoryContributionBuilder — category counts', () => {
    it('correctly categorizes memory contributions by type', () => {
        const memories = [
            makeMemoryItem('id-1', 'User name is Alex', { source: 'explicit', type: 'user_profile', salience: 0.8 }),
            makeMemoryItem('id-2', 'User is debugging Node.js', { type: 'technical', salience: 0.7, confidence: 0.8 }),
            makeMemoryItem('id-3', 'User prefers concise answers', { type: 'user_preference', salience: 0.6, confidence: 0.7 }),
            makeMemoryItem('id-4', 'Last session we discussed Vitest', { type: 'recent', salience: 0.5, confidence: 0.7 }),
        ];

        const model = MemoryContributionBuilder.build(memories, 4, 0, false, undefined, 'assistant');

        const categorized = model.contributions.reduce((acc, c) => {
            acc[c.category] = (acc[c.category] ?? 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        expect(categorized.identity).toBeGreaterThanOrEqual(1);
        expect(categorized.task_relevant).toBeGreaterThanOrEqual(1);
    });

    it('returns empty contributions when retrieval is suppressed', () => {
        const memories = [
            makeMemoryItem('m1', 'Some memory', { salience: 0.8, confidence: 0.9 }),
        ];

        const model = MemoryContributionBuilder.build(
            memories,
            1,
            0,
            true,    // retrievalSuppressed = true
            'Greeting intent',
            'assistant',
        );

        expect(model.contributions).toHaveLength(0);
        expect(model.retrievalSuppressed).toBe(true);
        expect(model.suppressionReason).toBe('Greeting intent');
    });

    it('respects per-category limits to prevent prompt flooding', () => {
        // Create 10 task-relevant memories — tiny profile allows max 3
        const memories = Array.from({ length: 10 }, (_, i) =>
            makeMemoryItem(`task-${i}`, `Task memory ${i}`, {
                type: 'technical',
                salience: 0.9 - i * 0.05,
                confidence: 0.8,
            })
        );

        const model = MemoryContributionBuilder.build(memories, 10, 0, false, undefined, 'assistant');

        const taskCount = model.contributions.filter(c => c.category === 'task_relevant').length;
        // Max task contributions by default for assistant mode is 5
        expect(taskCount).toBeLessThanOrEqual(5);
    });
});

// ─── Tests: Write policy resolution ──────────────────────────────────────────

describe('MemoryContributionBuilder — write policy', () => {
    it('returns do_not_write for RP mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('rp', 'general', false);
        expect(result.policy).toBe('do_not_write');
    });

    it('returns do_not_write for greeting turns', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'greeting', true);
        expect(result.policy).toBe('do_not_write');
    });

    it('returns long_term for technical intent in assistant mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('assistant', 'technical', false);
        expect(result.policy).toBe('long_term');
    });

    it('returns short_term for hybrid mode', () => {
        const result = MemoryContributionBuilder.resolveWritePolicy('hybrid', 'general', false);
        expect(result.policy).toBe('short_term');
    });
});
