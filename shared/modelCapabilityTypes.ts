/**
 * Model Capability Profile Types — Phase 3B: Small-Model Cognitive Compaction
 *
 * Defines the canonical type model for model capability classification,
 * cognitive budget profiles, and prompt profile selection.
 *
 * Design rules:
 * - Classification is deterministic and explainable.
 * - Budget caps are per-category (not flat token counts) for precise control.
 * - Profiles scale from tiny (3B-class) to large (>20B) without platform drift.
 * - Every compaction decision is auditable and diagnostics-friendly.
 */

// ─── Model parameter class ────────────────────────────────────────────────────

/**
 * Parameter class derived from estimated model size.
 *
 * tiny  : <= 4B   parameters (3B-class models)
 * small : >4B and <= 8B parameters
 * medium: >8B and <= 20B parameters
 * large : >20B parameters
 * unknown: size could not be determined (uses fallback classification)
 */
export type ModelParameterClass = 'tiny' | 'small' | 'medium' | 'large' | 'unknown';

// ─── Prompt profile class ─────────────────────────────────────────────────────

/**
 * Prompt profile class selected for a given model.
 * Governs which compaction policy and budget caps are applied.
 */
export type PromptProfileClass = 'tiny_profile' | 'small_profile' | 'medium_profile' | 'large_profile';

// ─── Compaction policy ────────────────────────────────────────────────────────

/**
 * Compaction strategy applied to a cognitive context for a given profile.
 *
 * aggressive : Strip all but identity core, mode, task, minimal tools, compressed emotion.
 * moderate   : Drop lower-priority memory/docs/reflection but keep richer tool guidance.
 * standard   : Include richer memory/docs/reflection with light compression.
 * full       : No compaction — full cognitive context passed through.
 */
export type CompactionPolicy = 'aggressive' | 'moderate' | 'standard' | 'full';

// ─── Cognitive budget profile ─────────────────────────────────────────────────

/**
 * Per-category cognitive budget caps for a prompt profile.
 * All values are item counts (not token counts) for deterministic control.
 */
export interface CognitiveBudgetProfile {
    /** Max identity memory contributions. */
    identityMemoryCap: number;
    /** Max task-relevant memory contributions. */
    taskMemoryCap: number;
    /** Max recent continuity memory contributions. */
    continuityMemoryCap: number;
    /** Max preference memory contributions. */
    preferenceMemoryCap: number;
    /** Max documentation chunks included. 0 = suppressed unless highly relevant. */
    docChunkCap: number;
    /** Max reflection behavioral notes included. */
    reflectionNoteCap: number;
    /** Max emotional modulation influence dimensions (from EmotionalModulationInput). */
    emotionalDimensionCap: number;
    /** Max tool descriptions / schemas included verbatim. */
    toolDescriptionCap: number;
    /** Whether full tool schemas are allowed (false = compact policy text only). */
    allowFullToolSchemas: boolean;
    /** Whether rich identity prose is allowed (false = compressed scaffold only). */
    allowFullIdentityProse: boolean;
    /** Whether docs are suppressed unless relevance score exceeds a threshold. */
    suppressDocsUnlessHighlyRelevant: boolean;
    /** Whether raw astro planetary data is allowed (false = compressed bias only). */
    allowRawAstroData: boolean;
}

// ─── Model capability profile ─────────────────────────────────────────────────

/**
 * Full capability descriptor for a provider/model combination.
 * Used by PromptProfileSelector to select the appropriate compaction strategy.
 */
export interface ModelCapabilityProfile {
    /** Stable identifier for this profile entry (e.g. "ollama/qwen2.5:3b"). */
    profileId: string;
    /** Display-friendly model name. */
    modelName: string;
    /** Provider type identifier. */
    providerType: string;
    /** Estimated parameter class. */
    parameterClass: ModelParameterClass;
    /** Prompt profile class selected for this model. */
    promptProfileClass: PromptProfileClass;
    /** Cognitive budget caps for the selected profile. */
    budgetProfile: CognitiveBudgetProfile;
    /** Compaction policy for this profile. */
    compactionPolicy: CompactionPolicy;
    /** Whether the parameter class was inferred (not directly specified). */
    classInferred: boolean;
    /** Rationale for the classification (for diagnostics/explainability). */
    classificationRationale: string;
    /** Estimated context window in tokens (if known). */
    estimatedContextTokens?: number;
}

// ─── Compact prompt packet ────────────────────────────────────────────────────

/**
 * Normalized compact prompt packet for tiny/small model inference.
 * Assembled deterministically from the compacted cognitive context.
 * Order is stable: identity → mode → emotion → tools → continuity → task → rules.
 */
export interface CompactPromptPacket {
    /** Identity core block. */
    identityCore: string;
    /** Active mode block. */
    modeBlock: string;
    /** Compressed emotional bias block. */
    emotionalBiasBlock: string;
    /** Tool policy block (concise). */
    toolPolicyBlock: string;
    /** Continuity/context block (top memory + explicit user facts). */
    continuityBlock: string;
    /** Current task/intent block. */
    currentTaskBlock: string;
    /** Response rules block. */
    responseRulesBlock: string;
    /** Assembled packet as ordered sections for final prompt injection. */
    assembledSections: string[];
    /** Diagnostics summary of what was kept and dropped. */
    diagnosticsSummary: CompactionDiagnosticsSummary;
}

// ─── Compaction diagnostics summary ──────────────────────────────────────────

/**
 * Human-readable compaction diagnostics.
 * Safe for IPC and UI surfaces — no raw prompt content.
 */
export interface CompactionDiagnosticsSummary {
    /** Profile class used. */
    profileClass: PromptProfileClass;
    /** Compaction policy applied. */
    compactionPolicy: CompactionPolicy;
    /** Model parameter class. */
    parameterClass: ModelParameterClass;
    /** Total memory items kept. */
    memoriesKept: number;
    /** Total memory items dropped. */
    memoriesDropped: number;
    /** Whether docs were included. */
    docsIncluded: boolean;
    /** Number of doc chunks included. */
    docChunksIncluded: number;
    /** Number of reflection notes kept. */
    reflectionNotesKept: number;
    /** Number of reflection notes dropped. */
    reflectionNotesDropped: number;
    /** Whether emotional modulation was included. */
    emotionIncluded: boolean;
    /** Whether full identity prose or compressed scaffold was used. */
    identityMode: 'full' | 'compressed';
    /** Whether full tool schemas or compact policy were used. */
    toolMode: 'full_schemas' | 'compact_policy';
    /** Sections included in the packet (in order). */
    sectionsIncluded: string[];
    /** Sections dropped under budget pressure. */
    sectionsDropped: string[];
    /** Human-readable compaction rationale. */
    rationale: string;
}

// ─── Compressed emotional bias ────────────────────────────────────────────────

/**
 * Compressed emotional behavioral deltas for small-model consumption.
 * Derived from EmotionalModulationInput — no raw astro data.
 */
export interface CompressedEmotionalBias {
    /** Applied warmth bias. */
    warmth: 'low' | 'neutral' | 'high';
    /** Applied caution bias. */
    caution: 'low' | 'neutral' | 'high';
    /** Applied confidence expression. */
    confidence: 'low' | 'neutral' | 'high';
    /** Applied energy/engagement level. */
    energy: 'low' | 'neutral' | 'high';
    /** Expression shift summary (bounded prose). */
    expressionShift: string;
    /** Whether modulation was available or gracefully absent. */
    available: boolean;
}

// ─── Compressed identity scaffold ────────────────────────────────────────────

/**
 * Compressed identity scaffold for small-model consumption.
 * Stable across turns and mode-independent for core identity elements.
 */
export interface CompressedIdentityScaffold {
    /** Tala's role (concise). */
    role: string;
    /** Tone guidance (concise). */
    tone: string;
    /** Top priorities (concise list). */
    priorities: string[];
    /** Behavioral boundaries (concise list). */
    boundaries: string[];
    /** Continuity rule (how Tala maintains continuity across turns). */
    continuityRule: string;
    /** Whether mode-specific context was appended. */
    modeContextAppended: boolean;
}

// ─── Compact tool guidance ────────────────────────────────────────────────────

/**
 * Compact tool guidance for small-model consumption.
 * No full tool schemas — concise behavior policy only.
 */
export interface CompactToolGuidance {
    /** Allowed tool categories summary (if any). */
    allowedSummary: string;
    /** Blocked tool categories summary (if any). */
    blockedSummary: string;
    /** Short use guidance (when to use tools). */
    useGuidance: string;
    /** Whether any tools are available. */
    toolsAvailable: boolean;
}
