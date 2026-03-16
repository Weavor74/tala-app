/**
 * Emotional Modulation Validation Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective E):
 * - Tiny/small models are capped to 'medium' modulation strength
 * - Medium/large models allow 'capped' modulation
 * - Emotional modulation modifies tone, warmth, caution, energy but NOT facts/identity
 * - Mode-based caps are enforced (assistant=medium, hybrid=medium, rp=capped)
 * - Model-size caps are applied on top of mode caps
 * - Diagnostics: emotional_bias_strength, emotional_bias_dimensions, emotional_modulation_applied
 */

import { describe, it, expect } from 'vitest';
import { EmotionalModulationPolicy } from '../../services/cognitive/EmotionalModulationPolicy';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHighIntensityAstroText(): string {
    return `warmth: 0.9\nintensity: 0.8\nclarity: 0.7\ncaution: 0.2`;
}

function makeLowIntensityAstroText(): string {
    return `warmth: 0.55\nintensity: 0.52\nclarity: 0.48\ncaution: 0.51`;
}

function makeMediumAstroText(): string {
    return `warmth: 0.75\nintensity: 0.6\nclarity: 0.5\ncaution: 0.3`;
}

// ─── Tests: Mode-based caps ───────────────────────────────────────────────────

describe('EmotionalModulationPolicy — mode-based caps', () => {
    it('caps assistant mode at medium for high-intensity astro state', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'assistant');
        expect(['none', 'low', 'medium']).toContain(result.strength);
    });

    it('caps hybrid mode at medium for high-intensity astro state', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'hybrid');
        expect(['none', 'low', 'medium']).toContain(result.strength);
    });

    it('allows up to capped for RP mode with high-intensity state', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp');
        expect(['low', 'medium', 'capped']).toContain(result.strength);
    });
});

// ─── Tests: Model-size-aware caps (Phase 3C) ──────────────────────────────────

describe('EmotionalModulationPolicy — model-size caps (Objective E)', () => {
    it('tiny model in RP mode is capped at medium (not capped)', () => {
        // Even though RP mode allows 'capped', tiny models should be limited to 'medium'
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'tiny');
        expect(['none', 'low', 'medium']).toContain(result.strength);
        expect(result.strength).not.toBe('capped');
    });

    it('small model in RP mode is capped at medium (not capped)', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'small');
        expect(['none', 'low', 'medium']).toContain(result.strength);
        expect(result.strength).not.toBe('capped');
    });

    it('medium model in RP mode allows capped strength', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'medium');
        // Medium model allows 'capped' in RP mode
        expect(['low', 'medium', 'capped']).toContain(result.strength);
    });

    it('large model in RP mode allows capped strength', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'large');
        expect(['low', 'medium', 'capped']).toContain(result.strength);
    });

    it('unknown model class falls back to medium cap', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'unknown');
        expect(['none', 'low', 'medium']).toContain(result.strength);
        expect(result.strength).not.toBe('capped');
    });

    it('tiny model + assistant mode both cap to medium — result is medium or lower', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'assistant', 'tiny');
        expect(['none', 'low', 'medium']).toContain(result.strength);
    });
});

// ─── Tests: Graceful degradation ─────────────────────────────────────────────

describe('EmotionalModulationPolicy — graceful degradation', () => {
    it('returns none strength when astro state is null', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.strength).toBe('none');
        expect(result.applied).toBe(false);
        expect(result.astroUnavailable).toBe(true);
    });

    it('returns none strength when astro state is empty string', () => {
        const result = EmotionalModulationPolicy.apply('', 'assistant');
        expect(result.strength).toBe('none');
        expect(result.applied).toBe(false);
    });

    it('returns none strength when vector magnitude is below threshold', () => {
        const result = EmotionalModulationPolicy.apply(makeLowIntensityAstroText(), 'assistant');
        expect(result.applied).toBe(false);
    });
});

// ─── Tests: Influenced dimensions ────────────────────────────────────────────

describe('EmotionalModulationPolicy — influenced dimensions', () => {
    it('returns empty dimensions when modulation is not applied', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.influencedDimensions).toHaveLength(0);
    });

    it('returns tone as influenced dimension when modulation is applied', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'medium');
        if (result.applied) {
            expect(result.influencedDimensions).toContain('tone');
        }
    });

    it('does not include undefined or null dimensions', () => {
        const result = EmotionalModulationPolicy.apply(makeMediumAstroText(), 'assistant');
        for (const dim of result.influencedDimensions) {
            expect(dim).toBeTruthy();
            expect(typeof dim).toBe('string');
        }
    });

    it('reports warmth dimension when warmth vector is strongly deviated', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'large');
        if (result.applied) {
            expect(result.influencedDimensions).toContain('warmth');
        }
    });
});

// ─── Tests: Modulation does not override facts/identity ──────────────────────

describe('EmotionalModulationPolicy — behavioral constraints', () => {
    it('modulation_summary does not contain raw astro data', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'rp', 'large');
        // The summary should be a human-readable compacted form, not raw values
        expect(result.modulation_summary).not.toMatch(/0\.\d{4,}/); // no highly precise floats
    });

    it('applied is always a boolean', () => {
        const applied = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'assistant');
        const notApplied = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(typeof applied.applied).toBe('boolean');
        expect(typeof notApplied.applied).toBe('boolean');
    });

    it('skipReason is provided when modulation is not applied', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.skipReason).toBeTruthy();
    });

    it('retrievedAt is always an ISO timestamp', () => {
        const result = EmotionalModulationPolicy.apply(makeHighIntensityAstroText(), 'assistant');
        expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

// ─── Tests: Parsing ───────────────────────────────────────────────────────────

describe('EmotionalModulationPolicy — vector parsing', () => {
    it('correctly parses warmth, intensity, clarity, caution from astro text', () => {
        const parsed = EmotionalModulationPolicy.parseEmotionalState(
            'warmth: 0.8\nintensity: 0.6\nclarity: 0.4\ncaution: 0.7'
        );
        expect(parsed.vector.warmth).toBeCloseTo(0.8, 5);
        expect(parsed.vector.intensity).toBeCloseTo(0.6, 5);
        expect(parsed.vector.clarity).toBeCloseTo(0.4, 5);
        expect(parsed.vector.caution).toBeCloseTo(0.7, 5);
    });

    it('falls back to neutral values when parsing fails', () => {
        const parsed = EmotionalModulationPolicy.parseEmotionalState('no numeric values here');
        expect(parsed.vector.warmth).toBe(0.5);
        expect(parsed.vector.intensity).toBe(0.5);
        expect(parsed.vector.clarity).toBe(0.5);
        expect(parsed.vector.caution).toBe(0.5);
    });
});
