import path from 'path';

/**
 * DocMetadata - Structured attributes for project documentation.
 */
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

/**
 * DocumentationClassifier - Metadata Inference Service
 * 
 * Analyzes file paths and content to assign structured metadata to TALA's 
 * internal documentation. This allows the retriever to prioritize 
 * architectural blueprints and technical specs over logs or generic notes.
 */
export class DocumentationClassifier {
    /**
     * Infer metadata for a given document file path.
     * 
     * Mapping rules are derived from the TALA project structure:
     * - docs/architecture/ -> type: architecture, priority: high
     * - docs/interfaces/ -> type: interface, priority: high
     * - docs/traceability/ -> type: technical, priority: high
     * - docs/audit/ -> type: log, priority: normal
     * - docs/features/ -> type: process, priority: normal
     */
    public static classify(filePath: string): DocMetadata {
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        const fileName = path.basename(normalizedPath).replace(/\.md$/, '');

        const meta: DocMetadata = {
            doc_type: 'general',
            authority: 0.5,
            priority: 'normal',
            tags: [fileName]
        };

        // Directory-based classification
        if (normalizedPath.includes('/docs/architecture/')) {
            meta.doc_type = 'architecture';
            meta.authority = 1.0;
            meta.priority = 'high';
            meta.tags.push('core', 'design');
        } else if (normalizedPath.includes('/docs/interfaces/')) {
            meta.doc_type = 'interface';
            meta.authority = 0.9;
            meta.priority = 'high';
            meta.tags.push('api', 'contract');
        } else if (normalizedPath.includes('/docs/traceability/')) {
            meta.doc_type = 'technical';
            meta.authority = 0.8;
            meta.priority = 'high';
            meta.tags.push('audit', 'logic');
        } else if (normalizedPath.includes('/docs/audit/')) {
            meta.doc_type = 'log';
            meta.priority = 'normal';
            meta.tags.push('history');
        } else if (normalizedPath.includes('/docs/features/')) {
            meta.doc_type = 'process';
            meta.tags.push('user-facing');
        } else if (normalizedPath.includes('/docs/security/')) {
            meta.doc_type = 'technical';
            meta.authority = 1.0;
            meta.priority = 'high';
            meta.tags.push('security', 'policy');
        }

        // Specific file overrides
        if (fileName === 'self_improvement_ecosystem') {
            meta.doc_type = 'architecture';
            meta.priority = 'high';
            meta.tags.push('reflection', 'loop');
        } else if (fileName === 'tdp_index') {
            meta.doc_type = 'technical';
            meta.authority = 0.9;
            meta.tags.push('index', 'governance');
        }

        return meta;
    }
}
