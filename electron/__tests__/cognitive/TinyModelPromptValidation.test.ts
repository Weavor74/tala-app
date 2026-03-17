/**
 * Tiny Model Prompt Validation Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective A):
 * - PromptProfileSelector selects the correct profile for each model class
 * - CompactPromptPacket contains only the approved fields for tiny/small models
 * - Token budget categories are present and properly constrained
 * - Raw MCP payloads, raw astro data, full doc chunks, and large tool schemas
 *   are never included in tiny/small packets
 * - Compaction diagnostics expose prompt_profile, and section information
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyModelCapability } from '../../services/cognitive/ModelCapabilityClassifier';
import { PromptProfileSelector } from '../../services/cognitive/PromptProfileSelector';
import { CognitiveContextCompactor } from '../../services/cognitive/CognitiveContextCompactor';
import type { TalaCognitiveContext } from '../../../shared/cognitiveTurnTypes';
import type { InferenceProviderType } from '../../../shared/inferenceProviderTypes';

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

function makeProvider(providerType: InferenceProviderType = 'ollama', providerId = 'test') {
    return { providerId, providerType, displayName: 'Test' };
}

function makeMinimalContext(overrides: Partial<TalaCognitiveContext> = {}): TalaCognitiveContext {
    const now = new Date().toISOString();
    return {
        turnId: 'test-turn-001',
        assembledAt: now,
        rawInput: 'Hello, what can you do?',
        normalizedInput: 'hello, what can you do?',
        modePolicy: {
            mode: 'assistant',
            memoryRetrievalPolicy: 'full',
            memoryWritePolicy: 'short_term',
            toolUsePolicy: 'all',
            docRetrievalPolicy: 'enabled',
            emotionalExpressionBounds: 'low',
            appliedAt: now,
        },
        memoryContributions: {
            contributions: [],
            candidateCount: 0,
            excludedCount: 0,
            retrievalSuppressed: false,
            retrievedAt: now,
        },
        docContributions: {
            applied: false,
            rationale: 'No docs retrieved',
            sourceIds: [],
            retrievedAt: now,
        },
        emotionalModulation: {
            applied: false,
            strength: 'none',
            influencedDimensions: [],
            modulation_summary: 'Not applied',
            astroUnavailable: true,
            retrievedAt: now,
        },
        reflectionContributions: {
            activeNotes: [],
            suppressedNotes: [],
            applied: false,
        },
        providerMetadata: {
            fallbackApplied: false,
            runtimeDegraded: false,
        },
        assemblyInputsSummary: [],
        wasCompacted: false,
        correlationId: 'corr-001',
        ...overrides,
    };
}

// ─── Tests: Profile selection ─────────────────────────────────────────────────

describe('PromptProfileSelector — profile selection by model size', () => {
    const selector = new PromptProfileSelector();
    const provider = makeProvider();

    it('selects tiny_profile for a 3B model', () => {
        const profile = selector.select(provider, 'qwen2.5:3b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.parameterClass).toBe('tiny');
        expect(profile.compactionPolicy).toBe('aggressive');
    });

    it('selects tiny_profile for a 1.5B model', () => {
        const profile = selector.select(provider, 'phi3:1.5b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.parameterClass).toBe('tiny');
    });

    it('selects tiny_profile for a 4B model (boundary)', () => {
        const profile = selector.select(provider, 'gemma:4b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.parameterClass).toBe('tiny');
    });

    it('selects small_profile for a 7B model', () => {
        const profile = selector.select(provider, 'llama3.1:7b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('small_profile');
        expect(profile.parameterClass).toBe('small');
        expect(profile.compactionPolicy).toBe('moderate');
    });

    it('selects small_profile for an 8B model (upper boundary)', () => {
        const profile = selector.select(provider, 'llama3:8b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('small_profile');
        expect(profile.parameterClass).toBe('small');
    });

    it('selects medium_profile for a 13B model', () => {
        const profile = selector.select(provider, 'llama2:13b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('medium_profile');
        expect(profile.parameterClass).toBe('medium');
        expect(profile.compactionPolicy).toBe('standard');
    });

    it('selects large_profile for a 70B model', () => {
        const profile = selector.select(provider, 'llama3:70b', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('large_profile');
        expect(profile.parameterClass).toBe('large');
        expect(profile.compactionPolicy).toBe('full');
    });

    it('defaults cloud provider to large_profile when model name has no size indicator', () => {
        const cloudProvider = makeProvider('openai', 'openai');
        const profile = selector.select(cloudProvider, 'gpt-4-turbo', 'turn-001', 'assistant');
        expect(profile.promptProfileClass).toBe('large_profile');
        expect(profile.parameterClass).toBe('large');
    });
});

// ─── Tests: Tiny profile budget constraints ────────────────────────────────────

describe('Tiny profile — budget constraints', () => {
    it('tiny_profile has correct budget caps', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const budget = profile.budgetProfile;

        expect(budget.identityMemoryCap).toBe(2);
        expect(budget.taskMemoryCap).toBe(3);
        expect(budget.continuityMemoryCap).toBe(2);
        expect(budget.preferenceMemoryCap).toBe(0);
        expect(budget.docChunkCap).toBe(1);
        expect(budget.reflectionNoteCap).toBe(1);
        expect(budget.allowFullToolSchemas).toBe(false);
        expect(budget.allowFullIdentityProse).toBe(false);
        expect(budget.allowRawAstroData).toBe(false);
        expect(budget.suppressDocsUnlessHighlyRelevant).toBe(true);
    });

    it('tiny_profile never allows raw astro data', () => {
        const profile = classifyModelCapability(makeProvider(), 'phi3:3.8b');
        expect(profile.budgetProfile.allowRawAstroData).toBe(false);
    });

    it('tiny_profile never allows full tool schemas', () => {
        const profile = classifyModelCapability(makeProvider(), 'gemma:2b');
        expect(profile.budgetProfile.allowFullToolSchemas).toBe(false);
    });
});

// ─── Tests: CompactPromptPacket structure ─────────────────────────────────────

describe('CognitiveContextCompactor — tiny model packet structure', () => {
    const compactor = new CognitiveContextCompactor();

    it('produces a packet with all required fields', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const context = makeMinimalContext();
        const packet = compactor.compact(context, profile);

        expect(packet.identityCore).toBeDefined();
        expect(packet.modeBlock).toBeDefined();
        expect(packet.emotionalBiasBlock).toBeDefined();
        expect(packet.toolPolicyBlock).toBeDefined();
        expect(packet.continuityBlock).toBeDefined();
        expect(packet.currentTaskBlock).toBeDefined();
        expect(packet.responseRulesBlock).toBeDefined();
        expect(packet.assembledSections).toBeInstanceOf(Array);
        expect(packet.diagnosticsSummary).toBeDefined();
    });

    it('diagnosticsSummary reports the correct profile class', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const context = makeMinimalContext();
        const packet = compactor.compact(context, profile);

        expect(packet.diagnosticsSummary.profileClass).toBe('tiny_profile');
        expect(packet.diagnosticsSummary.compactionPolicy).toBe('aggressive');
        expect(packet.diagnosticsSummary.parameterClass).toBe('tiny');
    });

    it('diagnosticsSummary reports compaction drops when memory exceeds budget', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const now = new Date().toISOString();

        // Create context with more task memories than the tiny budget allows (cap=3)
        const context = makeMinimalContext({
            memoryContributions: {
                contributions: [
                    { memoryId: 'm1', category: 'task_relevant', summary: 'Task A', rationale: 'r', influenceScope: ['task'], salience: 0.9 },
                    { memoryId: 'm2', category: 'task_relevant', summary: 'Task B', rationale: 'r', influenceScope: ['task'], salience: 0.8 },
                    { memoryId: 'm3', category: 'task_relevant', summary: 'Task C', rationale: 'r', influenceScope: ['task'], salience: 0.7 },
                    { memoryId: 'm4', category: 'task_relevant', summary: 'Task D', rationale: 'r', influenceScope: ['task'], salience: 0.6 },
                    { memoryId: 'm5', category: 'task_relevant', summary: 'Task E', rationale: 'r', influenceScope: ['task'], salience: 0.5 },
                ],
                candidateCount: 5,
                excludedCount: 0,
                retrievalSuppressed: false,
                retrievedAt: now,
            },
        });

        const packet = compactor.compact(context, profile);
        expect(packet.diagnosticsSummary.memoriesKept).toBeLessThanOrEqual(3); // tiny taskMemoryCap=3
        expect(packet.diagnosticsSummary.memoriesDropped).toBeGreaterThanOrEqual(2);
    });

    it('tiny model packet does not contain raw MCP/astro placeholders', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const context = makeMinimalContext();
        const packet = compactor.compact(context, profile);

        // None of the packet sections should reference raw MCP or astro data
        const fullText = packet.assembledSections.join(' ');
        expect(fullText).not.toMatch(/raw_astro|mcp_payload|callTool|tool_schema/i);
    });

    it('small model packet uses compact tool policy not full schemas', () => {
        const profile = classifyModelCapability(makeProvider(), 'llama3.1:7b');
        const context = makeMinimalContext();
        const packet = compactor.compact(context, profile);

        expect(packet.diagnosticsSummary.toolMode).toBe('compact_policy');
    });
});

// ─── Tests: Section order stability ───────────────────────────────────────────

describe('CompactPromptPacket — assembled section order', () => {
    const compactor = new CognitiveContextCompactor();

    it('assembles sections in canonical order for tiny profile', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        const context = makeMinimalContext();
        const packet = compactor.compact(context, profile);

        const includedKeys = packet.diagnosticsSummary.sectionsIncluded;
        // identity must appear before mode, mode before task
        const identityIdx = includedKeys.indexOf('identity');
        const modeIdx = includedKeys.indexOf('mode');
        const taskIdx = includedKeys.indexOf('task');

        if (identityIdx !== -1 && modeIdx !== -1) {
            expect(identityIdx).toBeLessThan(modeIdx);
        }
        if (modeIdx !== -1 && taskIdx !== -1) {
            expect(modeIdx).toBeLessThan(taskIdx);
        }
    });
});
