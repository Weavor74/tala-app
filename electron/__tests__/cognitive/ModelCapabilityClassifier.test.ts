/**
 * Model Capability Classification Tests — Phase 3B
 *
 * Validates:
 * - Known 3B/tiny models classified correctly
 * - Unknown models get deterministic fallback class
 * - Provider metadata influences classification
 * - Budget profiles have correct caps per class
 * - PromptProfileSelector emits telemetry
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    classifyModelCapability,
    extractParameterBillions,
    classifyParameterCount,
    promptProfileFromClass,
} from '../../services/cognitive/ModelCapabilityClassifier';
import { PromptProfileSelector } from '../../services/cognitive/PromptProfileSelector';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; summary: string; payload?: Record<string, unknown> }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_sub: string, et: string, _sev: string, _actor: string, sum: string, _status: string, opts?: { payload?: Record<string, unknown> }) => {
            emittedEvents.push({ eventType: et, summary: sum, payload: opts?.payload });
        },
        emit: () => {},
        audit: () => {},
        debug: () => {},
    },
}));

// ─── Provider helpers ─────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<Pick<InferenceProviderDescriptor, 'providerId' | 'providerType' | 'displayName'>> = {}) {
    return {
        providerId: 'test-provider',
        providerType: 'ollama' as const,
        displayName: 'Test Provider',
        ...overrides,
    };
}

// ─── Tests: Parameter extraction ─────────────────────────────────────────────

describe('extractParameterBillions', () => {
    it('extracts whole number B count from model name', () => {
        expect(extractParameterBillions('qwen2.5:3b')).toBe(3);
        expect(extractParameterBillions('llama3.1:8b')).toBe(8);
        expect(extractParameterBillions('llama-70b')).toBe(70);
        expect(extractParameterBillions('mistral:13b')).toBe(13);
    });

    it('extracts decimal B count from model name', () => {
        expect(extractParameterBillions('phi:1.5b')).toBe(1.5);
        expect(extractParameterBillions('gemma:2.7b')).toBe(2.7);
        expect(extractParameterBillions('tinyllama:0.5b')).toBe(0.5);
    });

    it('returns null for names with no parameter count', () => {
        expect(extractParameterBillions('gpt-4')).toBeNull();
        expect(extractParameterBillions('claude-3-sonnet')).toBeNull();
        expect(extractParameterBillions('unknown-model')).toBeNull();
    });
});

// ─── Tests: Parameter class ───────────────────────────────────────────────────

describe('classifyParameterCount', () => {
    it('classifies tiny models (<=4B)', () => {
        expect(classifyParameterCount(0.5)).toBe('tiny');
        expect(classifyParameterCount(1)).toBe('tiny');
        expect(classifyParameterCount(3)).toBe('tiny');
        expect(classifyParameterCount(4)).toBe('tiny');
    });

    it('classifies small models (>4B, <=8B)', () => {
        expect(classifyParameterCount(5)).toBe('small');
        expect(classifyParameterCount(7)).toBe('small');
        expect(classifyParameterCount(8)).toBe('small');
    });

    it('classifies medium models (>8B, <=20B)', () => {
        expect(classifyParameterCount(9)).toBe('medium');
        expect(classifyParameterCount(13)).toBe('medium');
        expect(classifyParameterCount(20)).toBe('medium');
    });

    it('classifies large models (>20B)', () => {
        expect(classifyParameterCount(21)).toBe('large');
        expect(classifyParameterCount(70)).toBe('large');
        expect(classifyParameterCount(405)).toBe('large');
    });
});

// ─── Tests: Profile mapping ───────────────────────────────────────────────────

describe('promptProfileFromClass', () => {
    it('maps each parameter class to correct profile', () => {
        expect(promptProfileFromClass('tiny')).toBe('tiny_profile');
        expect(promptProfileFromClass('small')).toBe('small_profile');
        expect(promptProfileFromClass('medium')).toBe('medium_profile');
        expect(promptProfileFromClass('large')).toBe('large_profile');
        expect(promptProfileFromClass('unknown')).toBe('small_profile');
    });
});

// ─── Tests: Full classification ───────────────────────────────────────────────

describe('classifyModelCapability', () => {
    it('classifies 3B model as tiny with aggressive compaction', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        expect(profile.parameterClass).toBe('tiny');
        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.compactionPolicy).toBe('aggressive');
        expect(profile.classInferred).toBe(false);
    });

    it('classifies 8B model as small with moderate compaction', () => {
        const profile = classifyModelCapability(makeProvider(), 'llama3.1:8b');
        expect(profile.parameterClass).toBe('small');
        expect(profile.promptProfileClass).toBe('small_profile');
        expect(profile.compactionPolicy).toBe('moderate');
    });

    it('classifies 13B model as medium with standard compaction', () => {
        const profile = classifyModelCapability(makeProvider(), 'mistral:13b');
        expect(profile.parameterClass).toBe('medium');
        expect(profile.promptProfileClass).toBe('medium_profile');
        expect(profile.compactionPolicy).toBe('standard');
    });

    it('classifies 70B model as large with full compaction', () => {
        const profile = classifyModelCapability(makeProvider(), 'llama-70b');
        expect(profile.parameterClass).toBe('large');
        expect(profile.promptProfileClass).toBe('large_profile');
        expect(profile.compactionPolicy).toBe('full');
    });

    it('uses cloud heuristic for unknown model name from cloud provider', () => {
        const profile = classifyModelCapability(
            makeProvider({ providerType: 'cloud' }),
            'gpt-4',
        );
        expect(profile.parameterClass).toBe('large');
        expect(profile.classInferred).toBe(true);
    });

    it('uses small fallback for embedded_vllm with unknown model', () => {
        const profile = classifyModelCapability(
            makeProvider({ providerType: 'embedded_vllm' }),
            'unknown-model',
        );
        expect(profile.parameterClass).toBe('small');
        expect(profile.classInferred).toBe(true);
    });

    it('uses unknown fallback for unknown provider + unknown model', () => {
        const profile = classifyModelCapability(
            makeProvider({ providerType: 'vllm' }),
            'unknown-model',
        );
        expect(profile.parameterClass).toBe('unknown');
        expect(profile.classInferred).toBe(true);
    });

    it('includes classification rationale', () => {
        const profile = classifyModelCapability(makeProvider(), 'qwen2.5:3b');
        expect(profile.classificationRationale).toContain('3');
        expect(profile.classificationRationale).toContain('tiny');
    });
});

// ─── Tests: Budget caps ───────────────────────────────────────────────────────

describe('budget profiles', () => {
    it('tiny profile has conservative caps', () => {
        const profile = classifyModelCapability(makeProvider(), 'phi:1.5b');
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

    it('large profile has generous caps', () => {
        const profile = classifyModelCapability(makeProvider(), 'llama-70b');
        const budget = profile.budgetProfile;
        expect(budget.identityMemoryCap).toBe(5);
        expect(budget.taskMemoryCap).toBe(8);
        expect(budget.reflectionNoteCap).toBe(4);
        expect(budget.allowFullToolSchemas).toBe(true);
        expect(budget.allowFullIdentityProse).toBe(true);
        expect(budget.suppressDocsUnlessHighlyRelevant).toBe(false);
    });
});

// ─── Tests: PromptProfileSelector telemetry ───────────────────────────────────

describe('PromptProfileSelector', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('selects tiny profile for 3B model and emits telemetry', () => {
        const selector = new PromptProfileSelector();
        const profile = selector.select(makeProvider(), 'qwen2.5:3b', 'turn-1', 'assistant');

        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.parameterClass).toBe('tiny');

        const event = emittedEvents.find(e => e.eventType === 'prompt_profile_selected');
        expect(event).toBeDefined();
        expect(event?.payload?.['promptProfileClass']).toBe('tiny_profile');
        expect(event?.payload?.['parameterClass']).toBe('tiny');
        expect(event?.payload?.['agentMode']).toBe('assistant');
    });

    it('selects large profile for cloud model and emits telemetry', () => {
        const selector = new PromptProfileSelector();
        const profile = selector.select(
            makeProvider({ providerType: 'cloud' }),
            'gpt-4',
            'turn-2',
            'assistant',
        );

        expect(profile.promptProfileClass).toBe('large_profile');

        const event = emittedEvents.find(e => e.eventType === 'prompt_profile_selected');
        expect(event).toBeDefined();
        expect(event?.payload?.['promptProfileClass']).toBe('large_profile');
    });
});
