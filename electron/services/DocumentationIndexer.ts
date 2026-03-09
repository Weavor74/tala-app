import fs from 'fs';
import path from 'path';
import { DocumentationClassifier, DocMetadata } from './DocumentationClassifier';
import { DocumentationChunker, DocChunk } from './DocumentationChunker';

/**
 * IndexedDoc - Result of processing a single documentation file.
 */
export interface IndexedDoc {
    /** The inferred metadata for the document. */
    metadata: DocMetadata;
    /** The array of chunks derived from document content. */
    chunks: DocChunk[];
    /** Original file metadata. */
    fileInfo: {
        path: string;
        mtime: number;
        size: number;
    };
}

/**
 * DocIndex - The complete serialized documentation model.
 */
export interface DocIndex {
    /** Index version for schema migration (e.g., '1.0'). */
    version: string;
    /** Timestamp of the last successful crawl. */
    generatedAt: string;
    /** Comprehensive list of indexed documents. */
    documents: IndexedDoc[];
}

/**
 * DocumentationIndexer - Knowledge Aggregation Service
 * 
 * Responsible for crawling the local filesystem, processing markdown files, 
 * and generating a structured index for the Documentation Retrieval layer.
 */
export class DocumentationIndexer {
    private docsDir: string;
    private indexDir: string;

    constructor(baseDir: string) {
        this.docsDir = path.join(baseDir, 'docs');
        this.indexDir = path.join(baseDir, 'data', 'docs_index');
    }

    /**
     * Performs a full crawl and index generation.
     * 
     * **Process:**
     * 1. Initializes the `data/docs_index/` directory.
     * 2. Recursively walks the `docs/` folder for .md files.
     * 3. For each file: Classifies (metadata) -> Read -> Chunk (decomposition).
     * 4. Serializes the combined `DocIndex` to disk.
     */
    public async rebuild(): Promise<DocIndex> {
        console.log(`[DocIndexer] Starting index rebuild in: ${this.docsDir}...`);

        if (!fs.existsSync(this.indexDir)) {
            fs.mkdirSync(this.indexDir, { recursive: true });
        }

        const documents: IndexedDoc[] = [];
        this.walkSync(this.docsDir, (filePath) => {
            if (filePath.endsWith('.md')) {
                try {
                    const stats = fs.statSync(filePath);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const relativePath = path.relative(path.dirname(this.docsDir), filePath);

                    const metadata = DocumentationClassifier.classify(filePath);
                    const chunks = DocumentationChunker.chunk(content, relativePath);

                    documents.push({
                        metadata,
                        chunks,
                        fileInfo: {
                            path: relativePath,
                            mtime: stats.mtimeMs,
                            size: stats.size
                        }
                    });
                } catch (e) {
                    console.error(`[DocIndexer] Error indexing ${filePath}:`, e);
                }
            }
        });

        const index: DocIndex = {
            version: '1.0',
            generatedAt: new Date().toISOString(),
            documents
        };

        const indexPath = path.join(this.indexDir, 'docs.json');
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
        console.log(`[DocIndexer] Index rebuild complete. ${documents.length} docs processed.`);

        return index;
    }

    /**
     * Loads the existing index from disk if available.
     */
    public load(): DocIndex | null {
        const indexPath = path.join(this.indexDir, 'docs.json');
        if (fs.existsSync(indexPath)) {
            try {
                return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            } catch (e) {
                console.error(`[DocIndexer] Failed to load index:`, e);
                return null;
            }
        }
        return null;
    }

    /** Helper to recursively traverse directories. */
    private walkSync(dir: string, callback: (path: string) => void) {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
                this.walkSync(filePath, callback);
            } else {
                callback(filePath);
            }
        });
    }
}
