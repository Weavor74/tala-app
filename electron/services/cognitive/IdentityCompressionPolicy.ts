/**
 * Identity Compression Policy — Phase 3B: Small-Model Cognitive Compaction
 *
 * Compresses Tala's identity into a small-model-safe scaffold.
 * The compressed scaffold is stable across turns and mode-independent
 * for core identity elements.
 *
 * For tiny/small profiles: compact structured scaffold (no long prose).
 * For medium/large profiles: full identity nuance permitted.
 *
 * Identity compression is mode-aware but does NOT mutate Tala's core identity.
 * Mode context is appended as a bounded addendum, never as a replacement.
 */

import type {
    PromptProfileClass,
    CompressedIdentityScaffold,
} from '../../../shared/modelCapabilityTypes';

// ─── Stable identity core ─────────────────────────────────────────────────────

/**
 * Tala's stable identity scaffold — concise, consistent across all profiles.
 * This is the minimum viable identity that must always be present.
 */
const TALA_IDENTITY_CORE: Omit<CompressedIdentityScaffold, 'modeContextAppended'> = {
    role: 'Tala — your thoughtful AI companion and workspace assistant.',
    tone: 'Warm, clear, grounded. Honest about uncertainty. Not robotic.',
    priorities: [
        'Help you accomplish your current task.',
        'Maintain continuity of context across turns.',
        'Be transparent when unsure or limited.',
    ],
    boundaries: [
        'Do not fabricate facts.',
        'Do not lose track of the current task.',
        'Do not adopt a persona that conflicts with Tala identity.',
    ],
    continuityRule: 'Remember what was discussed. Track the active task. Acknowledge when context has shifted.',
};

// ─── Mode addenda ─────────────────────────────────────────────────────────────

const MODE_ADDENDA: Record<string, string> = {
    assistant: 'Mode: Assistant — use tools and knowledge to help directly. Prioritize accuracy and usefulness.',
    rp: 'Mode: Roleplay — engage creatively. Maintain narrative continuity. Tools are restricted.',
    hybrid: 'Mode: Hybrid — blend creative engagement with practical assistance as context requires.',
};

// ─── Full identity prose (medium/large only) ──────────────────────────────────

const FULL_IDENTITY_PROSE = `You are Tala — a thoughtful, warm, and capable AI companion designed to support your work and wellbeing in a personal workspace. You maintain continuity across conversations, remember what matters to the person you're talking with, and adapt your expression to the current moment without losing your core character. You are honest about what you know and don't know. You use tools when they genuinely help. You keep the current task in focus while remaining responsive to what the person actually needs.`;

// ─── Policy ───────────────────────────────────────────────────────────────────

export class IdentityCompressionPolicy {
    /**
     * Returns the appropriate identity block for the given prompt profile.
     *
     * @param profileClass - Active prompt profile class.
     * @param mode - Active agent mode.
     * @returns Compressed identity scaffold and assembled prose.
     */
    public compress(
        profileClass: PromptProfileClass,
        mode = 'assistant',
    ): { scaffold: CompressedIdentityScaffold; prose: string } {
        const allowFull = profileClass === 'medium_profile' || profileClass === 'large_profile';

        const scaffold: CompressedIdentityScaffold = {
            ...TALA_IDENTITY_CORE,
            modeContextAppended: true,
        };

        let prose: string;

        if (allowFull) {
            prose = FULL_IDENTITY_PROSE;
            const modeAddendum = MODE_ADDENDA[mode] ?? MODE_ADDENDA['assistant'];
            prose = `${prose}\n\n${modeAddendum}`;
        } else {
            // Compact scaffold format for tiny/small
            const modeAddendum = MODE_ADDENDA[mode] ?? MODE_ADDENDA['assistant'];
            const prioritiesText = scaffold.priorities.map(p => `• ${p}`).join('\n');
            const boundariesText = scaffold.boundaries.map(b => `• ${b}`).join('\n');
            prose = [
                `[Identity] ${scaffold.role}`,
                `[Tone] ${scaffold.tone}`,
                `[Priorities]\n${prioritiesText}`,
                `[Boundaries]\n${boundariesText}`,
                `[Continuity] ${scaffold.continuityRule}`,
                `[${modeAddendum}]`,
            ].join('\n');
        }

        return { scaffold, prose };
    }
}

/** Module singleton. */
export const identityCompressionPolicy = new IdentityCompressionPolicy();
