/**
 * Compression Policy Tests — Phase 3B
 *
 * Validates:
 * - IdentityCompressionPolicy: stable scaffold, bounded length, no long prose in tiny
 * - ToolCompressionPolicy: concise guidance, no schemas in tiny
 * - EmotionalCompressionPolicy: compressed biases, no raw astro data, graceful degradation
 * - CognitiveBudgetApplier: category caps respected, prioritization rules enforced
 */

import { describe, it, expect } from 'vitest';
import { IdentityCompressionPolicy } from '../../services/cognitive/IdentityCompressionPolicy';
import { ToolCompressionPolicy } from '../../services/cognitive/ToolCompressionPolicy';
import { EmotionalCompressionPolicy } from '../../services/cognitive/EmotionalCompressionPolicy';
import { CognitiveBudgetApplier } from '../../services/cognitive/CognitiveBudgetApplier';
import { classifyModelCapability } from '../../services/cognitive/ModelCapabilityClassifier';
import type {
    MemoryContributionModel,
    DocContributionModel,
    ReflectionContributionModel,
    EmotionalModulationInput,
} from '../../../shared/cognitiveTurnTypes';

// ─── IdentityCompressionPolicy ────────────────────────────────────────────────

describe('IdentityCompressionPolicy', () => {
    const policy = new IdentityCompressionPolicy();

    it('returns compact scaffold for tiny profile', () => {
        const { prose, scaffold } = policy.compress('tiny_profile', 'assistant');
        expect(scaffold.role).toContain('Tala');
        expect(scaffold.priorities.length).toBeGreaterThan(0);
        expect(scaffold.boundaries.length).toBeGreaterThan(0);
        // Compact format uses bracket labels
        expect(prose).toContain('[Identity]');
        expect(prose).toContain('[Tone]');
        expect(prose).toContain('[Mode');
    });

    it('returns compact scaffold for small profile', () => {
        const { prose } = policy.compress('small_profile', 'assistant');
        expect(prose).toContain('[Identity]');
    });

    it('returns full prose for medium profile', () => {
        const { prose } = policy.compress('medium_profile', 'assistant');
        // Full prose does not use bracket label format
        expect(prose).not.toContain('[Identity]');
        expect(prose).toContain('Tala');
    });

    it('returns full prose for large profile', () => {
        const { prose } = policy.compress('large_profile', 'assistant');
        expect(prose).not.toContain('[Identity]');
        expect(prose).toContain('Tala');
    });

    it('includes mode context in all profiles', () => {
        for (const profile of ['tiny_profile', 'small_profile', 'medium_profile', 'large_profile'] as const) {
            const { prose } = policy.compress(profile, 'assistant');
            expect(prose.toLowerCase()).toContain('assistant');
        }
    });

    it('mode does not mutate core identity — role/tone/priorities/boundaries stable', () => {
        const { scaffold: rpScaffold } = policy.compress('tiny_profile', 'rp');
        const { scaffold: assistantScaffold } = policy.compress('tiny_profile', 'assistant');
        // Core identity fields should be identical regardless of mode
        expect(rpScaffold.role).toBe(assistantScaffold.role);
        expect(rpScaffold.tone).toBe(assistantScaffold.tone);
        expect(rpScaffold.priorities).toEqual(assistantScaffold.priorities);
        expect(rpScaffold.boundaries).toEqual(assistantScaffold.boundaries);
    });

    it('tiny profile uses compressed scaffold, not full persona prose', () => {
        const { prose: tinyProse } = policy.compress('tiny_profile', 'assistant');
        const { prose: largeProse } = policy.compress('large_profile', 'assistant');
        // Tiny uses bracket-label format, large uses flowing prose
        expect(tinyProse).toContain('[Identity]');
        expect(largeProse).not.toContain('[Identity]');
    });
});

// ─── ToolCompressionPolicy ────────────────────────────────────────────────────

describe('ToolCompressionPolicy', () => {
    const policy = new ToolCompressionPolicy();
    const tinyBudget = classifyModelCapability(
        { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'qwen2.5:3b',
    ).budgetProfile;
    const largeBudget = classifyModelCapability(
        { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'llama-70b',
    ).budgetProfile;

    it('returns no-tool guidance when toolUsePolicy is none', () => {
        const result = policy.compress('tiny_profile', 'none', tinyBudget);
        expect(result.toolsAvailable).toBe(false);
        expect(result.useGuidance).toContain('[Tools]');
        expect(result.blockedSummary).toBeTruthy();
    });

    it('returns concise tool guidance for tiny profile (no schemas)', () => {
        const result = policy.compress('tiny_profile', 'all', tinyBudget);
        expect(result.toolsAvailable).toBe(true);
        expect(result.useGuidance).toContain('[Tools]');
        // No tool names/schemas in tiny profile
        expect(result.allowedSummary).toBe('');
    });

    it('returns concise tool guidance for small profile', () => {
        const smallBudget = classifyModelCapability(
            { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'llama3.1:8b',
        ).budgetProfile;
        const result = policy.compress('small_profile', 'all', smallBudget);
        expect(result.toolsAvailable).toBe(true);
        expect(result.allowedSummary).toBe('');
    });

    it('may include tool names in large profile when tools are available', () => {
        const result = policy.compress('large_profile', 'all', largeBudget, ['search', 'memory', 'files']);
        expect(result.toolsAvailable).toBe(true);
        // Large profile may include tool names
        expect(result.allowedSummary).toContain('search');
    });
});

// ─── EmotionalCompressionPolicy ──────────────────────────────────────────────

describe('EmotionalCompressionPolicy', () => {
    const policy = new EmotionalCompressionPolicy();

    const activeModulation: EmotionalModulationInput = {
        applied: true,
        strength: 'low',
        influencedDimensions: ['tone', 'warmth', 'caution_bias'],
        modulation_summary: 'Slightly warmer tone for engagement. Minor caution on task assumptions.',
        astroUnavailable: false,
        retrievedAt: new Date().toISOString(),
    };

    it('returns available=false when astro is unavailable', () => {
        const input: EmotionalModulationInput = {
            applied: false,
            strength: 'none',
            influencedDimensions: [],
            modulation_summary: '',
            astroUnavailable: true,
            skipReason: 'AstroService unavailable',
            retrievedAt: new Date().toISOString(),
        };
        const result = policy.compress(input, 'tiny_profile');
        expect(result.available).toBe(false);
    });

    it('returns available=false when modulation not applied', () => {
        const input: EmotionalModulationInput = {
            applied: false,
            strength: 'none',
            influencedDimensions: [],
            modulation_summary: '',
            astroUnavailable: false,
            skipReason: 'Greeting turn',
            retrievedAt: new Date().toISOString(),
        };
        const result = policy.compress(input, 'tiny_profile');
        expect(result.available).toBe(false);
    });

    it('compresses warmth and caution biases from dimensions', () => {
        const result = policy.compress(activeModulation, 'tiny_profile');
        expect(result.available).toBe(true);
        // warmth dimension should produce a non-neutral warmth bias
        expect(result.warmth).not.toBe('neutral');
    });

    it('does not include raw astro data in output', () => {
        const result = policy.compress(activeModulation, 'tiny_profile');
        const block = policy.toPromptBlock(result);
        expect(block).not.toContain('natal');
        expect(block).not.toContain('transit');
        expect(block).not.toContain('planetary');
        expect(block).not.toContain('astro');
    });

    it('expression shift is shorter for tiny profile', () => {
        const resultTiny = policy.compress(activeModulation, 'tiny_profile');
        const resultLarge = policy.compress(activeModulation, 'large_profile');
        if (resultTiny.expressionShift && resultLarge.expressionShift) {
            expect(resultTiny.expressionShift.length).toBeLessThanOrEqual(
                resultLarge.expressionShift.length,
            );
        }
    });

    it('toPromptBlock returns empty string when unavailable', () => {
        const unavailable = policy.compress(
            { applied: false, strength: 'none', influencedDimensions: [], modulation_summary: '', astroUnavailable: true, retrievedAt: '' },
            'tiny_profile',
        );
        expect(policy.toPromptBlock(unavailable)).toBe('');
    });
});

// ─── CognitiveBudgetApplier ───────────────────────────────────────────────────

describe('CognitiveBudgetApplier — memory budget', () => {
    const applier = new CognitiveBudgetApplier();
    const tinyBudget = classifyModelCapability(
        { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'qwen2.5:3b',
    ).budgetProfile;

    const makeMemoryModel = (): MemoryContributionModel => ({
        contributions: [
            // 3 identity memories
            { memoryId: 'id-1', category: 'identity', summary: 'Alice', rationale: 'r', influenceScope: ['identity'], salience: 0.9 },
            { memoryId: 'id-2', category: 'identity', summary: 'Engineer', rationale: 'r', influenceScope: ['identity'], salience: 0.85 },
            { memoryId: 'id-3', category: 'identity', summary: 'Uses Mac', rationale: 'r', influenceScope: ['identity'], salience: 0.7 },
            // 4 task memories
            { memoryId: 'task-1', category: 'task_relevant', summary: 'Project Alpha', rationale: 'r', influenceScope: ['task'], salience: 0.88 },
            { memoryId: 'task-2', category: 'task_relevant', summary: 'React stack', rationale: 'r', influenceScope: ['task'], salience: 0.75 },
            { memoryId: 'task-3', category: 'task_relevant', summary: 'Deadline Friday', rationale: 'r', influenceScope: ['task'], salience: 0.65 },
            { memoryId: 'task-4', category: 'task_relevant', summary: 'PR merged', rationale: 'r', influenceScope: ['task'], salience: 0.50 },
            // 2 preference memories
            { memoryId: 'pref-1', category: 'preference', summary: 'Prefers concise', rationale: 'r', influenceScope: ['style'], salience: 0.6 },
            { memoryId: 'pref-2', category: 'preference', summary: 'Dislikes jargon', rationale: 'r', influenceScope: ['style'], salience: 0.55 },
        ],
        candidateCount: 9,
        excludedCount: 0,
        retrievalSuppressed: false,
        retrievedAt: new Date().toISOString(),
    });

    it('respects identity cap (tiny=2)', () => {
        const result = applier.applyMemoryBudget(makeMemoryModel(), tinyBudget);
        const identityKept = result.kept.filter(m => m.category === 'identity');
        expect(identityKept.length).toBe(2); // cap=2
    });

    it('respects task cap (tiny=3)', () => {
        const result = applier.applyMemoryBudget(makeMemoryModel(), tinyBudget);
        const taskKept = result.kept.filter(m => m.category === 'task_relevant');
        expect(taskKept.length).toBe(3); // cap=3
    });

    it('drops preference memories for tiny (preferenceMemoryCap=0)', () => {
        const result = applier.applyMemoryBudget(makeMemoryModel(), tinyBudget);
        const prefKept = result.kept.filter(m => m.category === 'preference');
        expect(prefKept.length).toBe(0); // cap=0
        const prefDropped = result.dropped.filter(m => m.category === 'preference');
        expect(prefDropped.length).toBe(2);
    });

    it('kept memories are sorted by salience within category', () => {
        const result = applier.applyMemoryBudget(makeMemoryModel(), tinyBudget);
        const taskKept = result.kept.filter(m => m.category === 'task_relevant');
        // Highest salience tasks should be kept
        expect(taskKept[0].salience).toBeGreaterThanOrEqual(taskKept[1].salience);
    });

    it('total kept + dropped equals total contributions', () => {
        const model = makeMemoryModel();
        const result = applier.applyMemoryBudget(model, tinyBudget);
        expect(result.keptCount + result.droppedCount).toBe(model.contributions.length);
    });
});

describe('CognitiveBudgetApplier — doc budget', () => {
    const applier = new CognitiveBudgetApplier();
    const tinyBudget = classifyModelCapability(
        { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'qwen2.5:3b',
    ).budgetProfile;

    it('suppresses docs when not applied', () => {
        const model: DocContributionModel = {
            applied: false,
            rationale: 'No relevant docs',
            sourceIds: [],
            retrievedAt: new Date().toISOString(),
        };
        const result = applier.applyDocBudget(model, tinyBudget);
        expect(result.included).toBe(false);
    });

    it('suppresses docs when cap is 0', () => {
        const model: DocContributionModel = {
            applied: true,
            summary: 'Some docs',
            rationale: 'Docs retrieved',
            sourceIds: ['doc-001'],
            retrievedAt: new Date().toISOString(),
        };
        const zeroBudget = { ...tinyBudget, docChunkCap: 0 };
        const result = applier.applyDocBudget(model, zeroBudget);
        expect(result.included).toBe(false);
    });

    it('includes docs when applied and cap > 0 and sources exist', () => {
        const model: DocContributionModel = {
            applied: true,
            summary: 'Project Alpha overview',
            rationale: 'Relevant docs',
            sourceIds: ['doc-001'],
            retrievedAt: new Date().toISOString(),
        };
        // Use a budget that allows docs
        const allowDocsBudget = { ...tinyBudget, docChunkCap: 1, suppressDocsUnlessHighlyRelevant: false };
        const result = applier.applyDocBudget(model, allowDocsBudget);
        expect(result.included).toBe(true);
        expect(result.summary).toBe('Project Alpha overview');
    });
});

describe('CognitiveBudgetApplier — reflection budget', () => {
    const applier = new CognitiveBudgetApplier();
    const tinyBudget = classifyModelCapability(
        { providerId: 'test', providerType: 'ollama', displayName: 'T' }, 'qwen2.5:3b',
    ).budgetProfile;

    it('respects reflection note cap (tiny=1)', () => {
        const now = new Date().toISOString();
        const model: ReflectionContributionModel = {
            activeNotes: [
                { noteId: 'n1', noteClass: 'preference_reminder', summary: 'High conf note', confidence: 0.9, generatedAt: now, expiresAt: now, applicationCount: 0, maxApplications: 5, suppressed: false },
                { noteId: 'n2', noteClass: 'caution_note', summary: 'Low conf note', confidence: 0.5, generatedAt: now, expiresAt: now, applicationCount: 0, maxApplications: 5, suppressed: false },
            ],
            suppressedNotes: [],
            applied: true,
        };
        const result = applier.applyReflectionBudget(model, tinyBudget);
        expect(result.keptCount).toBe(1); // cap=1
        expect(result.kept[0].confidence).toBe(0.9); // highest confidence kept
        expect(result.droppedCount).toBe(1);
    });

    it('drops suppressed notes', () => {
        const now = new Date().toISOString();
        const model: ReflectionContributionModel = {
            activeNotes: [
                { noteId: 'n1', noteClass: 'caution_note', summary: 'Active', confidence: 0.9, generatedAt: now, expiresAt: now, applicationCount: 0, maxApplications: 5, suppressed: false },
                { noteId: 'n2', noteClass: 'stability_note', summary: 'Suppressed', confidence: 0.8, generatedAt: now, expiresAt: now, applicationCount: 0, maxApplications: 5, suppressed: true },
            ],
            suppressedNotes: [],
            applied: true,
        };
        const result = applier.applyReflectionBudget(model, tinyBudget);
        // Suppressed note should be dropped
        expect(result.kept.some(n => n.noteId === 'n2')).toBe(false);
        expect(result.dropped.some(n => n.noteId === 'n2')).toBe(true);
    });
});
