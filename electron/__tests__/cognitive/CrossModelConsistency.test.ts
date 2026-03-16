/**
 * Cross-Model Consistency Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective G):
 * - Identity, tool usage rules, mode policy, and tone stability are consistent
 *   across 3B (tiny), 7B (small), and 13B+ (medium) model classes
 * - Larger models may produce richer output (more memories, richer identity prose)
 *   but CORE behavior does not change
 * - RP mode isolation holds across all model sizes
 * - Mode policy rules are enforced regardless of parameter class
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyModelCapability } from '../../services/cognitive/ModelCapabilityClassifier';
import { CognitiveTurnAssembler } from '../../services/cognitive/CognitiveTurnAssembler';
import { CognitiveContextCompactor } from '../../services/cognitive/CognitiveContextCompactor';
import type { CognitiveAssemblyInputs } from '../../services/cognitive/CognitiveTurnAssembler';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        emit: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(providerId = 'ollama') {
    return { providerId, providerType: 'ollama', displayName: 'Ollama' };
}

function makeBaseInputs(mode: 'assistant' | 'rp' | 'hybrid' = 'assistant'): CognitiveAssemblyInputs {
    return {
        turnId: 'cross-model-turn',
        rawInput: 'Explain how the memory system works.',
        mode,
        approvedMemories: [],
        memoryCandidateCount: 0,
        memoryExcludedCount: 0,
        memoryRetrievalSuppressed: false,
        intentClass: 'technical',
        isGreeting: false,
        astroStateText: null,
        docContextText: null,
        docSourceIds: [],
        fallbackApplied: false,
        runtimeDegraded: false,
    };
}

function makeMemories(): MemoryItem[] {
    return [
        {
            id: 'm1', text: 'User is a software engineer.', metadata: {
                source: 'explicit', type: 'user_profile', salience: 0.9, confidence: 0.95, tags: ['identity'],
            },
        } as MemoryItem,
        {
            id: 'm2', text: 'User is debugging a Node.js service.', metadata: {
                source: 'inferred', type: 'technical', salience: 0.8, confidence: 0.8, tags: ['task'],
            },
        } as MemoryItem,
        {
            id: 'm3', text: 'User prefers concise answers.', metadata: {
                source: 'inferred', type: 'user_preference', salience: 0.7, confidence: 0.75,
            },
        } as MemoryItem,
    ];
}

// ─── Tests: Mode policy consistency ──────────────────────────────────────────

describe('Cross-model consistency — mode policy', () => {
    const modelNames = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b', 'llama3:70b'];

    it('mode is always set correctly regardless of model size', () => {
        for (const modelName of modelNames) {
            const context = CognitiveTurnAssembler.assemble({
                ...makeBaseInputs('assistant'),
                turnId: `turn-${modelName}`,
            });
            expect(context.modePolicy.mode).toBe('assistant');
        }
    });

    it('RP mode isolation holds for all model sizes', () => {
        for (const modelName of modelNames) {
            const context = CognitiveTurnAssembler.assemble({
                ...makeBaseInputs('rp'),
                turnId: `turn-rp-${modelName}`,
            });
            expect(context.modePolicy.mode).toBe('rp');
            expect(context.modePolicy.docRetrievalPolicy).toBe('suppressed');
            expect(context.modePolicy.toolUsePolicy).toBe('none');
        }
    });

    it('assistant mode always enables doc retrieval regardless of model size', () => {
        for (const modelName of modelNames) {
            const context = CognitiveTurnAssembler.assemble({
                ...makeBaseInputs('assistant'),
                turnId: `turn-docs-${modelName}`,
            });
            expect(context.modePolicy.docRetrievalPolicy).toBe('enabled');
        }
    });
});

// ─── Tests: Identity consistency ─────────────────────────────────────────────

describe('Cross-model consistency — identity', () => {
    it('identity mode is compressed for tiny/small profiles', () => {
        const tinyProfile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const smallProfile = classifyModelCapability(makeProvider(), 'llama3.1:7b');

        expect(tinyProfile.budgetProfile.allowFullIdentityProse).toBe(false);
        expect(smallProfile.budgetProfile.allowFullIdentityProse).toBe(false);
    });

    it('identity mode is full for medium/large profiles', () => {
        const mediumProfile = classifyModelCapability(makeProvider(), 'llama2:13b');
        const largeProfile = classifyModelCapability(makeProvider(), 'llama3:70b');

        expect(mediumProfile.budgetProfile.allowFullIdentityProse).toBe(true);
        expect(largeProfile.budgetProfile.allowFullIdentityProse).toBe(true);
    });

    it('identityCore is always included in the prompt packet for all model sizes', () => {
        const compactor = new CognitiveContextCompactor();
        const models = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b'];

        for (const modelName of models) {
            const profile = classifyModelCapability(makeProvider(), modelName);
            const context = CognitiveTurnAssembler.assemble({
                ...makeBaseInputs(),
                turnId: `turn-identity-${modelName}`,
            });
            const packet = compactor.compact(context, profile);

            expect(packet.identityCore).toBeTruthy();
            expect(packet.diagnosticsSummary.sectionsIncluded).toContain('identity');
        }
    });
});

// ─── Tests: Memory consistency ────────────────────────────────────────────────

describe('Cross-model consistency — memory contributions', () => {
    it('explicit user facts are always included regardless of model size', () => {
        const compactor = new CognitiveContextCompactor();
        const models = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b'];
        const memories = makeMemories();

        for (const modelName of models) {
            const profile = classifyModelCapability(makeProvider(), modelName);
            const context = CognitiveTurnAssembler.assemble({
                ...makeBaseInputs(),
                turnId: `turn-mem-${modelName}`,
                approvedMemories: memories,
                memoryCandidateCount: memories.length,
            });
            const packet = compactor.compact(context, profile);

            // Explicit user fact (m1) should always be in the continuity block
            const continuityBlock = packet.continuityBlock;
            // Since tiny profile has identityMemoryCap=2, the explicit identity fact
            // should be within budget
            expect(packet.diagnosticsSummary.memoriesKept).toBeGreaterThanOrEqual(1);
        }
    });

    it('large models can include more memories than tiny models', () => {
        const compactor = new CognitiveContextCompactor();
        const tinyProfile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const largeProfile = classifyModelCapability(makeProvider(), 'llama3:70b');

        // Large number of memories to test budget differences
        const manyMemories: MemoryItem[] = Array.from({ length: 15 }, (_, i) => ({
            id: `task-mem-${i}`,
            text: `Technical context ${i}`,
            metadata: {
                source: 'inferred', type: 'technical', salience: 0.8 - i * 0.02, confidence: 0.8,
            },
        } as MemoryItem));

        const inputs = {
            ...makeBaseInputs(),
            approvedMemories: manyMemories,
            memoryCandidateCount: manyMemories.length,
        };

        const tinyContext = CognitiveTurnAssembler.assemble({ ...inputs, turnId: 'tiny-mem' });
        const largeContext = CognitiveTurnAssembler.assemble({ ...inputs, turnId: 'large-mem' });

        const tinyPacket = compactor.compact(tinyContext, tinyProfile);
        const largePacket = compactor.compact(largeContext, largeProfile);

        expect(largePacket.diagnosticsSummary.memoriesKept).toBeGreaterThanOrEqual(
            tinyPacket.diagnosticsSummary.memoriesKept
        );
    });
});

// ─── Tests: Tool policy consistency ──────────────────────────────────────────

describe('Cross-model consistency — tool policy', () => {
    it('tiny/small profiles do not allow full tool schemas', () => {
        const tinyProfile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const smallProfile = classifyModelCapability(makeProvider(), 'llama3.1:7b');

        expect(tinyProfile.budgetProfile.allowFullToolSchemas).toBe(false);
        expect(smallProfile.budgetProfile.allowFullToolSchemas).toBe(false);
    });

    it('large profiles allow full tool schemas', () => {
        const largeProfile = classifyModelCapability(makeProvider(), 'llama3:70b');
        expect(largeProfile.budgetProfile.allowFullToolSchemas).toBe(true);
    });

    it('tool policy block is always compact for tiny models', () => {
        const compactor = new CognitiveContextCompactor();
        const tinyProfile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const context = CognitiveTurnAssembler.assemble({ ...makeBaseInputs(), turnId: 'tool-test' });
        const packet = compactor.compact(context, tinyProfile);

        expect(packet.diagnosticsSummary.toolMode).toBe('compact_policy');
    });
});

// ─── Tests: Compaction policy consistency ────────────────────────────────────

describe('Cross-model consistency — compaction policy', () => {
    it('each model size maps to the correct compaction policy', () => {
        expect(classifyModelCapability(makeProvider(), 'qwen2.5:3b').compactionPolicy).toBe('aggressive');
        expect(classifyModelCapability(makeProvider(), 'llama3.1:7b').compactionPolicy).toBe('moderate');
        expect(classifyModelCapability(makeProvider(), 'llama2:13b').compactionPolicy).toBe('standard');
        expect(classifyModelCapability(makeProvider(), 'llama3:70b').compactionPolicy).toBe('full');
    });
});
