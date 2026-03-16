/**
 * EmotionalModulationValidation — Phase 3C: Cognitive Behavior Validation
 *
 * Validates the emotional modulation pipeline:
 *   - Astro unavailable → applied=false, strength='none'
 *   - Low-magnitude vector → applied=false
 *   - Medium-strength vector → applied=true, strength='medium'
 *   - Assistant mode cap prevents 'capped' strength
 *   - Tiny/small model cap limits to 'medium'
 *   - RP mode allows up to 'capped'
 *   - Bias instructions are non-empty when applied
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

import { EmotionalModulationPolicy } from '../electron/services/cognitive/EmotionalModulationPolicy';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmotionalModulationValidation', () => {
    it('returns applied=false when astro state is null', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.applied).toBe(false);
        expect(result.strength).toBe('none');
        expect(result.astroUnavailable).toBe(true);
    });

    it('returns applied=false when astro state is empty string', () => {
        const result = EmotionalModulationPolicy.apply('', 'assistant');
        expect(result.applied).toBe(false);
        expect(result.astroUnavailable).toBe(true);
    });

    it('returns applied=false when astro state is whitespace', () => {
        const result = EmotionalModulationPolicy.apply('   ', 'assistant');
        expect(result.applied).toBe(false);
        expect(result.astroUnavailable).toBe(true);
    });

    it('returns applied=false when vector magnitude is below threshold', () => {
        // Values near 0.5 → max deviation ≈ 0.05 < 0.15 threshold
        const nearNeutral = 'warmth: 0.55 intensity: 0.52 clarity: 0.48 caution: 0.53';
        const result = EmotionalModulationPolicy.apply(nearNeutral, 'assistant');
        expect(result.applied).toBe(false);
        expect(result.strength).toBe('none');
        expect(result.astroUnavailable).toBe(false);
    });

    it('applies modulation when astro state has meaningful vector', () => {
        const activeSignal = 'warmth: 0.7 intensity: 0.6 clarity: 0.65 caution: 0.4';
        const result = EmotionalModulationPolicy.apply(activeSignal, 'assistant');
        expect(result.applied).toBe(true);
        expect(['low', 'medium', 'capped']).toContain(result.strength);
    });

    it('caps modulation at medium in assistant mode', () => {
        // Max deviation = 0.5 → raw strength = 'capped', but assistant mode caps at 'medium'
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'assistant');
        expect(result.applied).toBe(true);
        expect(result.strength).toBe('medium');
    });

    it('caps modulation at medium in hybrid mode', () => {
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'hybrid');
        expect(result.applied).toBe(true);
        expect(result.strength).toBe('medium');
    });

    it('allows capped modulation in rp mode', () => {
        // Max deviation needs to be >= 0.5 (MEDIUM_THRESHOLD) to get 'capped'
        // warmth=1.0 → deviation=0.5, which equals MEDIUM_THRESHOLD → 'capped'
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'rp');
        expect(result.applied).toBe(true);
        expect(result.strength).toBe('capped');
    });

    it('tiny model caps modulation at medium even in rp mode', () => {
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'rp', 'tiny');
        expect(result.applied).toBe(true);
        expect(result.strength).toBe('medium');
    });

    it('small model caps modulation at medium', () => {
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'assistant', 'small');
        expect(result.applied).toBe(true);
        // small model + assistant mode → both cap at medium
        expect(result.strength).toBe('medium');
    });

    it('medium model allows capped modulation in rp mode', () => {
        const highSignal = 'warmth: 1.0 intensity: 1.0 clarity: 1.0 caution: 0.0';
        const result = EmotionalModulationPolicy.apply(highSignal, 'rp', 'medium');
        expect(result.applied).toBe(true);
        expect(result.strength).toBe('capped');
    });

    it('result includes a non-empty modulation_summary when applied', () => {
        const signal = 'warmth: 0.7 intensity: 0.6 clarity: 0.65 caution: 0.4';
        const result = EmotionalModulationPolicy.apply(signal, 'assistant');
        if (result.applied) {
            expect(result.modulation_summary).toBeTruthy();
            expect(result.modulation_summary!.length).toBeGreaterThan(0);
        }
    });

    it('result has a valid ISO retrievedAt timestamp', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(() => new Date(result.retrievedAt!)).not.toThrow();
        expect(new Date(result.retrievedAt!).toISOString()).toBe(result.retrievedAt);
    });

    it('influenced dimensions array is non-empty when applied', () => {
        const signal = 'warmth: 0.8 intensity: 0.7 clarity: 0.6 caution: 0.3';
        const result = EmotionalModulationPolicy.apply(signal, 'rp');
        if (result.applied) {
            expect(result.influencedDimensions).toBeInstanceOf(Array);
            expect(result.influencedDimensions.length).toBeGreaterThan(0);
        }
    });

    it('influenced dimensions array is empty when not applied', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.influencedDimensions).toBeInstanceOf(Array);
        expect(result.influencedDimensions).toHaveLength(0);
    });
});
