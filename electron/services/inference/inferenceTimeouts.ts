/**
 * Canonical inference timeout constants.
 *
 * IMPORTANT — semantic distinction:
 *
 *   STREAM_OPEN_TIMEOUT_*  — guards the pre-first-token window.
 *                            Fires when Ollama/llama.cpp has not yet emitted its
 *                            first token. Enables provider fallback.
 *                            Cleared immediately on first token.
 *
 *   OllamaBrain.TOKEN_SILENCE_MS — guards mid-stream stalls AFTER streaming has
 *                                   already opened. Fires when no token arrives for
 *                                   90 s during an active stream. Does NOT enable
 *                                   fallback because partial content would be lost.
 *                                   Defined locally in OllamaBrain — do NOT merge
 *                                   with STREAM_OPEN_TIMEOUT_LOCAL_MS even if the
 *                                   values happen to match.
 *
 * These constants are imported by:
 *   - electron/services/InferenceService.ts  (production)
 *   - electron/__tests__/inference/CanonicalStreaming.test.ts  (tests)
 */

/** Minimum character length of a prompt that triggers the large-prompt tier. */
export const LARGE_PROMPT_CHAR_THRESHOLD = 4_000;

/**
 * Stream-open timeout for local providers (Ollama, external llama.cpp, vLLM,
 * koboldcpp). 180 s baseline — covers cold-start model loading and slow RP models.
 * NOTE: countPromptChars() only counts messages[], not the system prompt string.
 * Keep this value generous enough for large system prompts even before the
 * large-prompt tier activates.
 */
export const STREAM_OPEN_TIMEOUT_LOCAL_MS = 180_000;

/**
 * Stream-open timeout for local providers when the prompt is large
 * (> LARGE_PROMPT_CHAR_THRESHOLD). 300 s covers RP models with large
 * character/lore context that is slow to prefill on CPU.
 */
export const STREAM_OPEN_TIMEOUT_LOCAL_LARGE_PROMPT_MS = 300_000;

/**
 * Stream-open timeout for embedded llama.cpp providers.
 * Same values as local — cold in-process model loads can exceed 30 s.
 */
export const STREAM_OPEN_TIMEOUT_EMBEDDED_MS = STREAM_OPEN_TIMEOUT_LOCAL_MS;
export const STREAM_OPEN_TIMEOUT_EMBEDDED_LARGE_PROMPT_MS = STREAM_OPEN_TIMEOUT_LOCAL_LARGE_PROMPT_MS;

/**
 * Stream-open timeout for cloud providers.
 * Only network latency matters here — 15 s is ample.
 * Must NOT be applied to local providers.
 */
export const STREAM_OPEN_TIMEOUT_CLOUD_MS = 15_000;
