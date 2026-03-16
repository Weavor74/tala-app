/**
 * Tool Compression Policy — Phase 3B: Small-Model Cognitive Compaction
 *
 * Compresses tool context into model-appropriate guidance.
 *
 * For tiny/small profiles: concise behavioral policy only — no schemas.
 * For medium/large profiles: may include more tool descriptions (still bounded).
 *
 * Never dumps long tool schemas into 3B-class models.
 * Mode policy (toolUsePolicy) shapes what guidance is included.
 */

import type {
    PromptProfileClass,
    CompactToolGuidance,
    CognitiveBudgetProfile,
} from '../../../shared/modelCapabilityTypes';

// ─── Base guidance text ───────────────────────────────────────────────────────

const TOOL_GUIDANCE_TINY = `[Tools] Answer directly when you have enough context. Use tools for retrieval, verification, or actions when needed. Do not mention tools unless they are useful.`;

const TOOL_GUIDANCE_SMALL = `[Tools] You have access to tools for retrieval, web search, file operations, and actions. Use them when they improve your answer. Prefer direct responses when context is sufficient. Avoid unnecessary tool calls.`;

const TOOL_GUIDANCE_MEDIUM_LARGE = `[Tools] You have access to a range of tools including memory retrieval, documentation search, web search, file operations, and external integrations. Use tools when they materially improve accuracy or completeness. Do not over-rely on tools for responses that can be answered directly. Tool calls are logged for transparency.`;

const TOOL_GUIDANCE_NONE = `[Tools] Tool use is not available in the current mode. Respond using available context only.`;

// ─── Policy ───────────────────────────────────────────────────────────────────

export class ToolCompressionPolicy {
    /**
     * Compresses tool context into model-appropriate guidance.
     *
     * @param profileClass - Active prompt profile class.
     * @param toolUsePolicy - Mode-derived tool use policy ('all' | 'task_only' | 'none').
     * @param budgetProfile - Budget profile governing allowed tool detail.
     * @param availableToolNames - Names of tools available (for brief listing in medium/large).
     * @returns CompactToolGuidance for inclusion in the prompt packet.
     */
    public compress(
        profileClass: PromptProfileClass,
        toolUsePolicy: 'all' | 'task_only' | 'none',
        budgetProfile: CognitiveBudgetProfile,
        availableToolNames: string[] = [],
    ): CompactToolGuidance {
        const toolsAvailable = toolUsePolicy !== 'none';

        if (!toolsAvailable) {
            return {
                allowedSummary: '',
                blockedSummary: 'All tools blocked by current mode.',
                useGuidance: TOOL_GUIDANCE_NONE,
                toolsAvailable: false,
            };
        }

        let allowedSummary = '';
        let useGuidance: string;

        switch (profileClass) {
            case 'tiny_profile':
                useGuidance = TOOL_GUIDANCE_TINY;
                break;
            case 'small_profile':
                useGuidance = TOOL_GUIDANCE_SMALL;
                break;
            default:
                // medium/large — may include brief tool listing
                useGuidance = TOOL_GUIDANCE_MEDIUM_LARGE;
                if (availableToolNames.length > 0 && budgetProfile.toolDescriptionCap > 0) {
                    const capped = availableToolNames.slice(0, budgetProfile.toolDescriptionCap);
                    allowedSummary = `Available tools: ${capped.join(', ')}.`;
                }
                break;
        }

        return {
            allowedSummary,
            blockedSummary: '',
            useGuidance,
            toolsAvailable: true,
        };
    }
}

/** Module singleton. */
export const toolCompressionPolicy = new ToolCompressionPolicy();
