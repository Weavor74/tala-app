/**
 * notebookGroundingContract.ts
 *
 * Single source of truth for the notebook strict grounding contract text.
 *
 * Imported by both ContextAssembler (router-level) and ContextAssemblyService
 * (IPC-level) so that the 9-rule prohibition block is defined exactly once.
 *
 * The contract uses OVERRIDE language so it takes precedence over conversational
 * persona and style directives that appear elsewhere in the system prompt.
 */

/**
 * 9-rule strict grounding contract for notebook source mode.
 *
 * This text is injected as a system block BEFORE the notebook evidence so the
 * model reads the constraints before processing any content.
 */
export const NOTEBOOK_GROUNDING_CONTRACT_TEXT =
  `You are operating in NOTEBOOK SOURCE MODE. The following rules OVERRIDE all other directives:\n\n` +
  `1. ONLY use the content provided under [CANON NOTEBOOK CONTEXT — STRICT] below.\n` +
  `2. DO NOT introduce facts, dates, timelines, names, or claims from outside the provided content.\n` +
  `3. DO NOT infer information that is not explicitly stated in the provided content.\n` +
  `4. DO NOT use your general training knowledge to fill in gaps.\n` +
  `5. If the content is insufficient to answer, say: "The available notebook content does not contain enough information to answer this."\n` +
  `6. You MAY quote directly from the content. You MAY paraphrase content.\n` +
  `7. You MAY note patterns, themes, or groupings — but ONLY based on what the content says.\n` +
  `8. Cite the source label (e.g. [1], [2]) for every factual claim you make.\n` +
  `9. Summaries must be source-bound. Do not editorialize or speculate.`;
