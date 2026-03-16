/**
 * Emotional Modulation Policy — Phase 3: Cognitive Loop (Objective D)
 *
 * Implements bounded emotional modulation from Tala's astro/emotional state.
 * Emotional state influences expression (tone, phrasing, warmth, caution bias)
 * without destabilizing identity or overriding explicit policy.
 *
 * Modulation bounds:
 * - low-strength: subtle tone shift, minimal influence
 * - medium-strength: moderate tone and phrasing influence
 * - capped: maximal allowed influence (never exceeds this)
 * - none: modulation suppressed or astro unavailable
 *
 * Emotional state must not:
 * - rewrite core identity
 * - override explicit policy
 * - arbitrarily suppress task competence
 * - create unexplained behavior swings
 *
 * When astro engine is unavailable, this module degrades gracefully by
 * returning a 'none' modulation with an explanatory skip reason.
 */

import type { EmotionalModulationInput, EmotionalModulationStrength } from '../../../shared/cognitiveTurnTypes';
import type { Mode } from '../router/ModePolicyEngine';

// ─── Emotional state shape (from AstroService) ────────────────────────────────

/**
 * Normalized emotional vector from the AstroService.
 * These values are extracted from the astro engine's raw string output.
 */
export interface EmotionalVector {
    /** Warmth dimension [0-1]. Higher = more nurturing/connected expression. */
    warmth: number;
    /** Intensity dimension [0-1]. Higher = more energetic/emphatic expression. */
    intensity: number;
    /** Clarity dimension [0-1]. Higher = more precise/direct expression. */
    clarity: number;
    /** Caution dimension [0-1]. Higher = more measured/careful expression. */
    caution: number;
}

/**
 * Parsed emotional state from the AstroService.
 */
export interface ParsedEmotionalState {
    vector: EmotionalVector;
    /** System instructions from astro engine (raw). */
    systemInstructions: string;
    /** Style guide from astro engine (raw). */
    styleGuide: string;
}

// ─── Modulation strength thresholds ──────────────────────────────────────────

/** Minimum vector magnitude to produce 'low' modulation. */
const LOW_THRESHOLD = 0.25;
/** Minimum vector magnitude to produce 'medium' modulation. */
const MEDIUM_THRESHOLD = 0.5;
/** Modulation is always capped at 'medium' in assistant mode. */
const ASSISTANT_MODE_CAP: EmotionalModulationStrength = 'medium';
/** Modulation cap in hybrid mode. */
const HYBRID_MODE_CAP: EmotionalModulationStrength = 'medium';
/** RP mode allows full modulation up to 'capped'. */
const RP_MODE_CAP: EmotionalModulationStrength = 'capped';

// ─── Minimum confidence threshold ─────────────────────────────────────────────

/** Below this average vector magnitude, modulation is suppressed as 'none'. */
const MIN_MAGNITUDE_FOR_MODULATION = 0.15;

// ─── EmotionalModulationPolicy ────────────────────────────────────────────────

/**
 * Applies bounded emotional modulation policy to produce a structured
 * EmotionalModulationInput for the cognitive turn.
 *
 * Policy rules:
 * 1. If astro engine is unavailable, return 'none' with skipReason.
 * 2. Compute average vector magnitude from parsed emotional state.
 * 3. Determine modulation strength from magnitude and mode-based cap.
 * 4. Identify influenced dimensions (warmth, caution, tone, phrasing, emphasis).
 * 5. Build a safe, summarized modulation description (no raw astro data).
 */
export class EmotionalModulationPolicy {
    /**
     * Applies the modulation policy and returns a structured EmotionalModulationInput.
     *
     * @param astroStateText - Raw string output from AstroService.getEmotionalState().
     *                         If null/empty, astro engine is treated as unavailable.
     * @param mode - Active cognitive mode.
     * @returns Structured EmotionalModulationInput for inclusion in TalaCognitiveContext.
     */
    public static apply(
        astroStateText: string | null | undefined,
        mode: Mode,
    ): EmotionalModulationInput {
        const now = new Date().toISOString();

        // Astro unavailable — graceful degraded behavior
        if (!astroStateText || astroStateText.trim().length === 0) {
            return {
                applied: false,
                strength: 'none',
                influencedDimensions: [],
                modulation_summary: 'Emotional modulation not applied.',
                astroUnavailable: true,
                skipReason: 'Astro engine unavailable or returned empty state',
                retrievedAt: now,
            };
        }

        // Parse the emotional vector from astro output
        const parsed = this.parseEmotionalState(astroStateText);

        // Compute average magnitude across all vector dimensions
        const magnitude = this.computeMagnitude(parsed.vector);

        // Below minimum threshold — treat as no meaningful modulation
        if (magnitude < MIN_MAGNITUDE_FOR_MODULATION) {
            return {
                applied: false,
                strength: 'none',
                influencedDimensions: [],
                modulation_summary: 'Emotional state magnitude below modulation threshold.',
                astroUnavailable: false,
                skipReason: `Vector magnitude ${magnitude.toFixed(2)} below threshold ${MIN_MAGNITUDE_FOR_MODULATION}`,
                retrievedAt: now,
            };
        }

        // Determine raw strength from magnitude
        const rawStrength = this.magnitudeToStrength(magnitude);

        // Apply mode-based cap
        const strength = this.applyModeCap(rawStrength, mode);

        // Identify influenced dimensions
        const influencedDimensions = this.identifyInfluencedDimensions(parsed.vector, strength);

        // Build safe summary
        const modulation_summary = this.buildSummary(parsed.vector, strength, mode);

        return {
            applied: true,
            strength,
            influencedDimensions,
            modulation_summary,
            astroUnavailable: false,
            retrievedAt: now,
        };
    }

    /**
     * Parses an EmotionalVector from the raw AstroService output string.
     * Attempts to extract numeric values; falls back to neutral values on parse failure.
     */
    public static parseEmotionalState(rawText: string): ParsedEmotionalState {
        // Default neutral vector
        const vector: EmotionalVector = { warmth: 0.5, intensity: 0.5, clarity: 0.5, caution: 0.5 };

        // Attempt to extract bracketed numeric values from the astro output
        // Pattern: "warmth: 0.7" or "Warmth: 0.7" etc.
        const extractDimension = (key: string): number | undefined => {
            const match = rawText.match(new RegExp(`${key}[:\\s]+([0-9.]+)`, 'i'));
            if (match) {
                const val = parseFloat(match[1]);
                if (!isNaN(val) && val >= 0 && val <= 1) return val;
            }
            return undefined;
        };

        const warmth = extractDimension('warmth');
        const intensity = extractDimension('intensity');
        const clarity = extractDimension('clarity');
        const caution = extractDimension('caution');

        if (warmth !== undefined) vector.warmth = warmth;
        if (intensity !== undefined) vector.intensity = intensity;
        if (clarity !== undefined) vector.clarity = clarity;
        if (caution !== undefined) vector.caution = caution;

        // Extract system instructions and style guide from astro block
        const systemMatch = rawText.match(/System Instructions[:\s]+(.*?)(?:\n|Style Guide|$)/is);
        const styleMatch = rawText.match(/Style Guide[:\s]+(.*?)(?:\n|Emotional Vector|$)/is);

        return {
            vector,
            systemInstructions: systemMatch ? systemMatch[1].trim().slice(0, 200) : '',
            styleGuide: styleMatch ? styleMatch[1].trim().slice(0, 200) : '',
        };
    }

    /**
     * Computes the maximum deviation across all emotional vector dimensions from neutral (0.5).
     * Uses max (rather than average) so that any single strongly-deviated dimension triggers
     * modulation — a high-warmth state should apply modulation even when all other dimensions
     * are neutral.
     */
    private static computeMagnitude(vector: EmotionalVector): number {
        const values = [vector.warmth, vector.intensity, vector.clarity, vector.caution];
        // Deviation from neutral (0.5): higher = more emotionally expressive in that dimension
        const deviations = values.map(v => Math.abs(v - 0.5));
        return Math.max(...deviations);
    }

    private static magnitudeToStrength(magnitude: number): EmotionalModulationStrength {
        if (magnitude >= MEDIUM_THRESHOLD) return 'capped';
        if (magnitude >= LOW_THRESHOLD) return 'medium';
        return 'low';
    }

    /**
     * Applies mode-based caps to prevent identity-destabilizing modulation.
     */
    private static applyModeCap(
        strength: EmotionalModulationStrength,
        mode: Mode,
    ): EmotionalModulationStrength {
        const modeCap = mode === 'rp' ? RP_MODE_CAP : mode === 'hybrid' ? HYBRID_MODE_CAP : ASSISTANT_MODE_CAP;

        // Convert to numeric for comparison
        const strengthRank: Record<EmotionalModulationStrength, number> = {
            none: 0,
            low: 1,
            medium: 2,
            capped: 3,
        };

        const capRank = strengthRank[modeCap];
        const rawRank = strengthRank[strength];

        if (rawRank > capRank) {
            return modeCap;
        }
        return strength;
    }

    /**
     * Identifies which behavioral dimensions are influenced given the vector and strength.
     */
    private static identifyInfluencedDimensions(
        vector: EmotionalVector,
        strength: EmotionalModulationStrength,
    ): Array<'tone' | 'phrasing' | 'emphasis' | 'warmth' | 'caution_bias'> {
        if (strength === 'none') return [];

        const influenced: Array<'tone' | 'phrasing' | 'emphasis' | 'warmth' | 'caution_bias'> = [];

        // Tone is influenced whenever there is meaningful modulation
        influenced.push('tone');

        if (Math.abs(vector.warmth - 0.5) > 0.2) influenced.push('warmth');
        if (Math.abs(vector.intensity - 0.5) > 0.2) influenced.push('emphasis');
        if (Math.abs(vector.clarity - 0.5) > 0.2) influenced.push('phrasing');
        if (Math.abs(vector.caution - 0.5) > 0.2) influenced.push('caution_bias');

        return influenced;
    }

    /**
     * Builds a safe, summarized description of the modulation effect.
     * Does not include raw astro data or unparsed emotional state strings.
     */
    private static buildSummary(
        vector: EmotionalVector,
        strength: EmotionalModulationStrength,
        mode: Mode,
    ): string {
        const parts: string[] = [`Strength: ${strength}`, `Mode: ${mode}`];

        if (vector.warmth > 0.65) parts.push('warmth elevated');
        else if (vector.warmth < 0.35) parts.push('warmth subdued');

        if (vector.intensity > 0.65) parts.push('intensity elevated');
        else if (vector.intensity < 0.35) parts.push('intensity subdued');

        if (vector.caution > 0.65) parts.push('caution elevated');
        else if (vector.caution < 0.35) parts.push('caution reduced');

        return parts.join('; ');
    }
}
