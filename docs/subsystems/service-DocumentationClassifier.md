# Service: DocumentationClassifier.ts

**Source**: [electron\services\DocumentationClassifier.ts](../../electron/services/DocumentationClassifier.ts)

## Class: `DocumentationClassifier`

## Overview
DocMetadata - Structured attributes for project documentation./
export interface DocMetadata {
    /** The broad functional category of the document. */
    doc_type: 'architecture' | 'interface' | 'technical' | 'log' | 'process' | 'general';
    /** Optional specific category (e.g., 'rest-api', 'agent-soul'). */
    subtype?: string;
    /** Trust level of the document (1.0 = Authoritative Source of Truth). */
    authority: number;
    /** Importance for retrieval ranking. */
    priority: 'high' | 'normal' | 'low';
    /** Descriptive labels for keyword matching. */
    tags: string[];
}

/** DocumentationClassifier - Metadata Inference Service  Analyzes file paths and content to assign structured metadata to TALA's  internal documentation. This allows the retriever to prioritize  architectural blueprints and technical specs over logs or generic notes.

### Methods

