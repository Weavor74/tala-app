# Service: DocumentationIntelligenceService.ts

**Source**: [electron/services/DocumentationIntelligenceService.ts](../../electron/services/DocumentationIntelligenceService.ts)

## Class: `DocumentationIntelligenceService`

## Overview
Doc retrieval is only triggered when the query matches one of these semantic
 patterns. Retrieval does NOT run on every turn — only when it will materially
 improve accuracy or diagnostics.

 Use cases:
 - Explaining subsystem or service behavior
 - Diagnosing architecture-level issues
 - Resolving where a capability is implemented
 - Identifying expected contracts between services
 - Clarifying intended mode / artifact / memory semantics
/
const DOC_RETRIEVAL_PATTERN =
    /\b(architecture|design|interface|spec|protocol|how does|explain|docs?|documentation|logic|engine|service|requirement|traceability|security|contract|schema|api|workflow|pipeline|subsystem|capability|memory|artifact|mode|reflection|telemetry|inference|audit)\b/i;

// ─── Structured retrieval result ──────────────────────────────────────────────

/**
 A single attributed documentation citation returned by the retrieval pipeline.
 Source attribution is always preserved for diagnostic and developer use.
/
export interface DocCitation {
    /** Relative path of the source document within the repo. */
    sourcePath: string;
    /** Heading within the document (for section-level attribution). */
    heading: string;
    /** Relevance score used for ranking (higher = more relevant). */
    score: number;
    /** The retrieved text content (trimmed, not the full document). */
    content: string;
}

/**
 Structured result from a documentation retrieval call.
 Carries attribution, gating metadata, and a prompt-ready context block.
/
export interface DocRetrievalResult {
    /** Whether retrieval was executed (false = gating suppressed it). */
    retrieved: boolean;
    /** Reason retrieval was suppressed, when retrieved=false. */
    suppressReason?: string;
    /** Gating rule label that matched (for telemetry). */
    gatingRuleMatched?: string;
    /** Ordered list of cited sources (highest score first). */
    citations: DocCitation[];
    /** Pre-formatted context block ready for LLM prompt injection. */
    promptContext: string;
    /** Duration of the retrieval operation in ms. */
    durationMs: number;
}

// ─── DocumentationIntelligenceService ────────────────────────────────────────

/**
 DocumentationIntelligenceService - Knowledge Orchestrator

 Phase 2 enhancements:
 - Gating policy: retrieval only executes when query matches known use cases.
 - Structured citation model with source attribution.
 - Telemetry emission for retrieval, suppression, and failures.
 - Runtime interface for other services to call intentionally.

 The service provides the primary interface for TALA to access project-level
 documentation. It manages the lifecycle of the documentation index
 (loading/rebuilding) and provides high-level context retrieval methods
 for the agentic loop.

### Methods

#### `ignite`
Initializes the service by loading or rebuilding the documentation index.

 **Flow:**
 - Attempts to load an existing index from disk (`data/docs_index/docs.json`).
 - If no index is found, triggers a full rebuild (crawl/classify/chunk).
 - Instantiates the `DocumentationRetriever` with the loaded index.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `refresh`
Rebuilds the documentation index on-demand.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `evaluateGating`
Evaluates the gating policy for a query.
 Returns whether retrieval should proceed and the rule label that matched.

 This is a public method used both by `queryWithGating()` internally and
 by callers that need to pre-check whether retrieval will be attempted
 (e.g., for diagnostics or telemetry annotation before calling queryWithGating).
/

**Arguments**: `query: string`
**Returns**: ``

---
#### `queryWithGating`
Runtime-safe documentation retrieval with gating policy, source attribution,
 and structured telemetry.

 - Does NOT run on every turn; gating policy is enforced here.
 - Results are ranked by score and attributed to source documents.
 - Emits telemetry for retrieval, suppression, and failure states.

 @param query - The user query or intent string used for retrieval.
 @param turnId - The current turn ID for telemetry correlation.
 @param mode - The current operating mode.
 @param maxResults - Maximum number of citations to return (default: 3).
 @returns A structured DocRetrievalResult.
/

**Arguments**: `query: string, turnId = 'global', mode = 'unknown', maxResults = 3`
**Returns**: `DocRetrievalResult`

---
#### `getRelevantContext`
Retrieves relevant documentation context formatted for LLM prompts.

 @deprecated Prefer `queryWithGating()` which enforces the gating policy
 and emits structured telemetry. This method is preserved for backward
 compatibility but bypasses the gating policy.

 @param query - The user query or intent string.
 @returns A string of documentation context blocks, or an empty string.
/

**Arguments**: `query: string`
**Returns**: `string`

---
#### `getStatus`
Diagnostic method to inspect the current index status.
/

**Arguments**: ``
**Returns**: ``

---
#### `buildPromptContext`
**Arguments**: `citations: DocCitation[]`
**Returns**: `string`

---
