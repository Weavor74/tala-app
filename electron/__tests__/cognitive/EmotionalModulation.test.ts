/**
 * Emotional Modulation Policy Tests — Phase 3
 *
 * Validates bounded emotional modulation from astro/emotional state.
 *
 * Coverage:
 * - Modulation applied within bounds per mode
 * - Unavailable astro engine degrades gracefully
 * - Modulation does not overwrite core identity (strength capping)
 * - Influenced dimensions correctly identified
 * - Mode caps enforced (assistant max: medium, rp max: capped)
 * - Low-magnitude vectors produce 'none' or 'low' modulation
 */

import { describe, it, expect } from 'vitest';
import { EmotionalModulationPolicy } from '../../services/cognitive/EmotionalModulationPolicy';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const NEUTRAL_ASTRO = '[ASTRO STATE]\nSystem Instructions: Normal state\nwarmth: 0.5\nintensity: 0.5\nclarity: 0.5\ncaution: 0.5';
const HIGH_WARMTH_ASTRO = '[ASTRO STATE]\nSystem Instructions: Be warm\nwarmth: 0.9\nintensity: 0.5\nclarity: 0.5\ncaution: 0.5';
const HIGH_ALL_ASTRO = '[ASTRO STATE]\nSystem Instructions: Intense state\nwarmth: 0.9\nintensity: 0.9\nclarity: 0.1\ncaution: 0.1';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmotionalModulationPolicy — graceful degradation', () => {
    it('returns none modulation when astro state is null', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.applied).toBe(false);
        expect(result.strength).toBe('none');
        expect(result.astroUnavailable).toBe(true);
        expect(result.skipReason).toBeTruthy();
    });

    it('returns none modulation when astro state is empty string', () => {
        const result = EmotionalModulationPolicy.apply('', 'assistant');
        expect(result.applied).toBe(false);
        expect(result.strength).toBe('none');
        expect(result.astroUnavailable).toBe(true);
    });

    it('returns none modulation when astro state is undefined', () => {
        const result = EmotionalModulationPolicy.apply(undefined, 'rp');
        expect(result.applied).toBe(false);
        expect(result.astroUnavailable).toBe(true);
    });

    it('includes retrievedAt timestamp even when astro unavailable', () => {
        const result = EmotionalModulationPolicy.apply(null, 'assistant');
        expect(result.retrievedAt).toBeTruthy();
        expect(() => new Date(result.retrievedAt)).not.toThrow();
    });
});

describe('EmotionalModulationPolicy — modulation bounds', () => {
    it('produces no significant modulation for neutral vector', () => {
        const result = EmotionalModulationPolicy.apply(NEUTRAL_ASTRO, 'assistant');
        // Neutral vector should produce 'none' or 'low' modulation
        expect(['none', 'low']).toContain(result.strength);
    });

    it('produces modulation for high warmth vector', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_WARMTH_ASTRO, 'rp');
        expect(result.applied).toBe(true);
        expect(result.strength).not.toBe('none');
        expect(result.influencedDimensions).toContain('tone');
        expect(result.influencedDimensions).toContain('warmth');
    });

    it('identifies multiple influenced dimensions for high-deviation vector', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_ALL_ASTRO, 'rp');
        expect(result.influencedDimensions.length).toBeGreaterThan(1);
    });
});

describe('EmotionalModulationPolicy — mode caps', () => {
    it('caps modulation at medium for assistant mode', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_ALL_ASTRO, 'assistant');
        // Assistant mode cap is 'medium'
        expect(['none', 'low', 'medium']).toContain(result.strength);
        expect(result.strength).not.toBe('capped');
    });

    it('caps modulation at medium for hybrid mode', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_ALL_ASTRO, 'hybrid');
        expect(['none', 'low', 'medium']).toContain(result.strength);
        expect(result.strength).not.toBe('capped');
    });

    it('allows capped modulation in rp mode', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_ALL_ASTRO, 'rp');
        // RP mode allows up to 'capped'
        expect(['low', 'medium', 'capped']).toContain(result.strength);
    });
});

describe('EmotionalModulationPolicy — identity stability', () => {
    it('does not include raw astro data in summary', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_WARMTH_ASTRO, 'rp');
        // Summary should not contain raw planetary position data
        expect(result.modulation_summary).not.toContain('[ASTRO STATE]');
        expect(result.modulation_summary).not.toContain('System Instructions');
    });

    it('summary describes modulation effect without raw content', () => {
        const result = EmotionalModulationPolicy.apply(HIGH_WARMTH_ASTRO, 'rp');
        expect(result.modulation_summary).toContain('Strength:');
        expect(result.modulation_summary).toContain('Mode:');
    });
});

describe('EmotionalModulationPolicy — vector parsing', () => {
    it('parses warmth dimension from astro output', () => {
        const parsed = EmotionalModulationPolicy.parseEmotionalState(HIGH_WARMTH_ASTRO);
        expect(parsed.vector.warmth).toBeCloseTo(0.9);
    });

    it('falls back to neutral vector when parsing fails', () => {
        const parsed = EmotionalModulationPolicy.parseEmotionalState('No numeric data here');
        expect(parsed.vector.warmth).toBeCloseTo(0.5);
        expect(parsed.vector.intensity).toBeCloseTo(0.5);
    });

    it('extracts system instructions when present', () => {
        const parsed = EmotionalModulationPolicy.parseEmotionalState(HIGH_WARMTH_ASTRO);
        expect(parsed.systemInstructions).toContain('warm');
    });
});
