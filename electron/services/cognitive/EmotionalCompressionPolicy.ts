/**
 * Emotional Compression Policy — Phase 3B: Small-Model Cognitive Compaction
 *
 * Converts EmotionalModulationInput into compact behavioral bias deltas
 * for small-model consumption. No raw astro data, no planetary tables.
 *
 * For tiny/small profiles: compressed warmth/caution/confidence/energy biases only.
 * For medium/large: same compressed output (raw astro never injected into prompts).
 *
 * Degrades gracefully when astro is unavailable.
 * Compressed guidance remains bounded and does not override identity or competence.
 */

import type {
    EmotionalModulationInput,
    EmotionalModulationStrength,
} from '../../../shared/cognitiveTurnTypes';
import type {
    CompressedEmotionalBias,
    PromptProfileClass,
} from '../../../shared/modelCapabilityTypes';

// ─── Strength → bias mapping ─────────────────────────────────────────────────

type BiasTier = 'low' | 'neutral' | 'high';

function strengthToBias(strength: EmotionalModulationStrength): BiasTier {
    switch (strength) {
        case 'none': return 'neutral';
        case 'low': return 'low';
        case 'medium': return 'neutral';
        case 'capped': return 'high';
    }
}

// ─── Dimension → bias mapping ─────────────────────────────────────────────────

function extractWarmth(
    dimensions: EmotionalModulationInput['influencedDimensions'],
    strength: EmotionalModulationStrength,
): BiasTier {
    if (dimensions.includes('warmth')) return strengthToBias(strength);
    return 'neutral';
}

function extractCaution(
    dimensions: EmotionalModulationInput['influencedDimensions'],
    strength: EmotionalModulationStrength,
): BiasTier {
    if (dimensions.includes('caution_bias')) return strengthToBias(strength);
    return 'neutral';
}

function extractConfidence(
    dimensions: EmotionalModulationInput['influencedDimensions'],
    strength: EmotionalModulationStrength,
): BiasTier {
    // Confidence inferred: if tone and emphasis are affected, confidence is influenced
    if (dimensions.includes('tone') || dimensions.includes('emphasis')) {
        return strengthToBias(strength) === 'high' ? 'high' : 'neutral';
    }
    return 'neutral';
}

function extractEnergy(
    dimensions: EmotionalModulationInput['influencedDimensions'],
    strength: EmotionalModulationStrength,
): BiasTier {
    if (dimensions.includes('emphasis') || dimensions.includes('phrasing')) {
        return strengthToBias(strength);
    }
    return 'neutral';
}

// ─── Expression shift summary ─────────────────────────────────────────────────

function buildExpressionShift(
    modulation: EmotionalModulationInput,
    profileClass: PromptProfileClass,
): string {
    if (!modulation.applied) return '';

    // For tiny/small: use the already-bounded modulation_summary field
    if (profileClass === 'tiny_profile' || profileClass === 'small_profile') {
        // Trim to a single sentence for compactness
        const summary = modulation.modulation_summary ?? '';
        const firstSentence = summary.split(/[.!?]/)[0]?.trim() ?? '';
        return firstSentence ? `${firstSentence}.` : '';
    }

    // For medium/large: include the full bounded summary
    return modulation.modulation_summary ?? '';
}

// ─── Policy ───────────────────────────────────────────────────────────────────

export class EmotionalCompressionPolicy {
    /**
     * Compresses EmotionalModulationInput into CompressedEmotionalBias.
     * No raw astro data is exposed at any profile level.
     *
     * @param modulation - The emotional modulation input from the cognitive turn.
     * @param profileClass - Active prompt profile class.
     * @returns CompressedEmotionalBias for inclusion in the prompt packet.
     */
    public compress(
        modulation: EmotionalModulationInput,
        profileClass: PromptProfileClass,
    ): CompressedEmotionalBias {
        if (!modulation.applied || modulation.astroUnavailable) {
            return {
                warmth: 'neutral',
                caution: 'neutral',
                confidence: 'neutral',
                energy: 'neutral',
                expressionShift: '',
                available: false,
            };
        }

        const dims = modulation.influencedDimensions;
        const strength = modulation.strength;

        return {
            warmth: extractWarmth(dims, strength),
            caution: extractCaution(dims, strength),
            confidence: extractConfidence(dims, strength),
            energy: extractEnergy(dims, strength),
            expressionShift: buildExpressionShift(modulation, profileClass),
            available: true,
        };
    }

    /**
     * Converts CompressedEmotionalBias to a brief prompt block.
     * Only non-neutral biases are mentioned.
     */
    public toPromptBlock(bias: CompressedEmotionalBias): string {
        if (!bias.available) return '';

        const parts: string[] = [];
        if (bias.warmth !== 'neutral') parts.push(`warmth: ${bias.warmth}`);
        if (bias.caution !== 'neutral') parts.push(`caution: ${bias.caution}`);
        if (bias.confidence !== 'neutral') parts.push(`confidence: ${bias.confidence}`);
        if (bias.energy !== 'neutral') parts.push(`energy: ${bias.energy}`);

        if (parts.length === 0 && !bias.expressionShift) return '';

        const biasLine = parts.length > 0 ? `[Tone bias] ${parts.join(', ')}.` : '';
        const shiftLine = bias.expressionShift ? `[Expression] ${bias.expressionShift}` : '';

        return [biasLine, shiftLine].filter(Boolean).join('\n');
    }
}

/** Module singleton. */
export const emotionalCompressionPolicy = new EmotionalCompressionPolicy();
