import path from 'path';
import fs from 'fs';
import { RagService } from './RagService';
import { LogViewerService } from './LogViewerService';

/**
 * Automated Knowledge Indexing Service.
 * 
 * The `IngestionService` monitors the workspace `memory/` directory and 
 * coordinates the ingestion of new documents into the RAG vector store. 
 * It ensures that the AI's long-term memory remains synchronized with 
 * local file changes.
 * 
 * **Core Responsibilities:**
 * - **Directory Monitoring**: Scans inbox folders (e.g., `roleplay`, `assistant`) 
 *   for new `.md` or `.txt` files.
 * - **Lifecycle Pipe**: Moves processed files to a dedicated `processed/` 
 *   directory after successful indexing.
 * - **Background Polling**: Operates a low-priority background loop to 
 *   periodically refresh the knowledge base.
 * - **Legacy Cleanup**: Handles archiving of deprecated memory formats.
 */
export class IngestionService {
    private isScanning = false;
    private isStructuredMode = false;
    private memoryDirPath: string;
    private processedDirPath: string;
    private logViewerService: LogViewerService | null = null;

    constructor(private rag: RagService, workspaceRoot: string) {
        this.memoryDirPath = path.join(workspaceRoot, 'memory');
        this.processedDirPath = path.join(this.memoryDirPath, 'processed');
    }

    public setLogViewerService(service: LogViewerService): void {
        this.logViewerService = service;
    }

    /**
     * Updates the workspace root and memory directory path.
     */
    public setWorkspaceRoot(root: string): void {
        this.memoryDirPath = path.join(root, 'memory');
        this.processedDirPath = path.join(this.memoryDirPath, 'processed');
    }

    /**
     * Toggles structured LTMF mode. If true, .txt files are ignored during ingestion scans.
     */
    public setStructuredMode(enabled: boolean): void {
        this.isStructuredMode = enabled;
        console.log(`[Ingestion] Structured LTMF mode: ${enabled ? 'ENABLED (Ignoring .txt)' : 'DISABLED'}`);
    }

    /**
     * Executes a full synchronization scan of the memory inbox.
     * 
     * **Workflow:**
     * 1. Verifies RAG baseline readiness.
     * 2. Scans designated folders for untracked documents.
     * 3. Moves each file to a category-specific `processed/` subdirectory.
     * 4. Calls `RagService.ingestFile` to generate embeddings and index the content.
     * 5. Logs performance metrics for ingestion latency.
     * 
     * @returns A summary of processed files and encountered errors.
     */
    public async scanAndIngest(): Promise<{ total: number; ingested: number; errors: number }> {
        if (this.isScanning) return { total: 0, ingested: 0, errors: 0 };
        this.isScanning = true;

        const results = { total: 0, ingested: 0, errors: 0 };

        try {
            // Guard: If RAG service isn't ready, don't even scan.
            if (!this.rag.getReadyStatus()) {
                console.warn('[Ingestion] RAG service not ready. Skipping scan.');
                return results;
            }

            // Define folders to scan
            const folders = [
                { name: 'root', path: this.memoryDirPath, category: 'general' },
                { name: 'roleplay', path: path.join(this.memoryDirPath, 'roleplay'), category: 'roleplay' },
                { name: 'assistant', path: path.join(this.memoryDirPath, 'assistant'), category: 'assistant' },
                { name: 'roleplay_md', path: path.join(this.memoryDirPath, 'roleplay_md'), category: 'roleplay' },
                // Also check processed/roleplay_md in case they were moved there without indexing
                { name: 'processed_roleplay_md', path: path.join(this.processedDirPath, 'roleplay_md'), category: 'roleplay' }
            ];

            // Ensure subdirectories exist
            for (const f of folders) {
                if (f.name !== 'root' && !fs.existsSync(f.path)) {
                    fs.mkdirSync(f.path, { recursive: true });
                }
            }

            // Ensure processed directory structure
            if (!fs.existsSync(this.processedDirPath)) {
                fs.mkdirSync(this.processedDirPath, { recursive: true });
            }

            // Get list of indexed files from RAG
            let indexedFiles: string[] = [];
            try {
                indexedFiles = await this.rag.listIndexedFiles();
            } catch (e: any) {
                console.error(`[Ingestion] Failed to list indexed files: ${e.message}. Aborting scan.`);
                return results;
            }
            const indexedSet = new Set(indexedFiles);

            // Scan each folder
            for (const folder of folders) {
                if (!fs.existsSync(folder.path)) continue;

                const files = fs.readdirSync(folder.path);
                // For root folder, filter out directories manually to avoid scanning 'processed' or 'roleplay' as files

                console.log(`[Ingestion] Scanning ${folder.name}: ${folder.path} (${files.length} items)`);

                for (const file of files) {
                    const fullPath = path.resolve(folder.path, file);
                    let stat;
                    try { stat = fs.statSync(fullPath); } catch { continue; }

                    if (stat.isDirectory()) continue;

                    const allowedExtensions = this.isStructuredMode ? ['.md', '.docx'] : ['.md', '.docx', '.txt'];
                    const ext = path.extname(file).toLowerCase();

                    if (stat.isFile() && allowedExtensions.includes(ext)) {
                        console.log(`[Ingestion] Found inbox file in ${folder.name}: ${file}`);

                        // Determine destination: memory/processed/{category}/file.txt
                        // Exception: general/root files go to memory/processed/file.txt (legacy compatible? or memory/processed/general?)
                        // Let's keep root files in processed/ root for simplicity, or move to processed/general?
                        // Plan said: processed/general. But let's stick to subfolders for everything to be clean.
                        // IF category is general, put in processed/general.

                        const destDir = path.join(this.processedDirPath, folder.category);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                        const destPath = path.join(destDir, file);

                        try {
                            // Move file
                            if (fs.existsSync(destPath)) {
                                fs.unlinkSync(destPath);
                            }
                            fs.renameSync(fullPath, destPath);
                            console.log(`[Ingestion] Moved to processed/${folder.category}: ${file}`);

                            // Ingest
                            console.log(`[Ingestion] Indexing ${folder.category} file: ${file}`);

                            const start = Date.now();
                            await this.rag.ingestFile(destPath, folder.category);
                            const duration = Date.now() - start;

                            if (this.logViewerService) {
                                this.logViewerService.logPerformanceMetric({
                                    metricType: 'ingestion_time',
                                    name: 'ingestion_time_ms',
                                    value: duration,
                                    unit: 'ms',
                                    subsystem: 'ingestion',
                                    metadata: {
                                        fileName: file,
                                        category: folder.category,
                                        sizeBytes: stat.size
                                    }
                                });
                            }

                            results.ingested++;

                        } catch (e: any) {
                            console.error(`[Ingestion] Failed to process ${file}:`, e);
                            results.errors++;
                        }
                    }
                }
            }
            results.total = 1; // Dummy total since we scan multiple folders
        } finally {
            this.isScanning = false;
        }

        return results;
    }

    /**
     * Starts a background polling loop for ingestion.
     */
    public startAutoIngest(intervalMs = 300000): void { // Default 5 mins
        // Run immediately on startup
        this.scanAndIngest().then(res => {
            if (res.ingested > 0) {
                console.log(`[Ingestion] Initial scan complete: ${res.ingested} new files indexed.`);
            }
        }).catch(err => console.error('[Ingestion] Initial scan error:', err));

        // Then poll periodically
        setInterval(() => {
            this.scanAndIngest().then(res => {
                if (res.ingested > 0) {
                    console.log(`[Ingestion] Background scan complete: ${res.ingested} new files indexed.`);
                }
            }).catch(err => console.error('[Ingestion] Background scan error:', err));
        }, intervalMs);
    }

    /**
     * Moves all legacy .txt files from processed folders to an archive directory.
     * This prevents them from being used for retrieval while preserving the files.
     */
    public async archiveLegacy(): Promise<number> {
        console.log('[Ingestion] Archiving legacy .txt memories...');
        const archiveDir = path.join(this.memoryDirPath, 'archive');
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }

        let archivedCount = 0;
        const categories = ['roleplay', 'assistant', 'general'];

        for (const cat of categories) {
            const catProcessedDir = path.join(this.processedDirPath, cat);
            if (!fs.existsSync(catProcessedDir)) continue;

            const files = fs.readdirSync(catProcessedDir);
            for (const file of files) {
                if (file.endsWith('.txt')) {
                    const srcPath = path.join(catProcessedDir, file);
                    const destCatDir = path.join(archiveDir, cat);
                    if (!fs.existsSync(destCatDir)) fs.mkdirSync(destCatDir, { recursive: true });

                    const destPath = path.join(destCatDir, file);
                    try {
                        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                        fs.renameSync(srcPath, destPath);
                        archivedCount++;
                    } catch (e) {
                        console.error(`[Ingestion] Failed to archive ${file}:`, e);
                    }
                }
            }
        }

        console.log(`[Ingestion] Archived ${archivedCount} legacy files.`);
        return archivedCount;
    }
}
