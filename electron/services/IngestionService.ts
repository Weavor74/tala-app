import path from 'path';
import fs from 'fs';
import { RagService } from './RagService';

/**
 * IngestionService
 * 
 * Monitors the 'memory/' directory and automatically ingests/indexes 
 * documents into the RAG system. Ensures that the AI's long-term memory
 * is always up to date.
 */
export class IngestionService {
    private isScanning = false;
    private memoryDirPath: string;

    private processedDirPath: string;

    constructor(private rag: RagService, workspaceRoot: string) {
        this.memoryDirPath = path.join(workspaceRoot, 'memory');
        this.processedDirPath = path.join(this.memoryDirPath, 'processed');
    }

    /**
     * Updates the workspace root and memory directory path.
     */
    public setWorkspaceRoot(root: string): void {
        this.memoryDirPath = path.join(root, 'memory');
        this.processedDirPath = path.join(this.memoryDirPath, 'processed');
    }

    /**
     * Performs a full scan of the memory directory and ingests any new/updated files.
     * Moves successfully ingested files to the 'processed' subdirectory.
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
                { name: 'assistant', path: path.join(this.memoryDirPath, 'assistant'), category: 'assistant' }
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

                    if (stat.isFile() && (file.endsWith('.md') || file.endsWith('.docx') || file.endsWith('.txt'))) {
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
                            // Pass category
                            await this.rag.ingestFile(destPath, folder.category);
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
     * Unifies file path formatting for consistent comparison across platforms.
     * matching the logic in RagService.ts.
     */
    private normalizePath(p: string): string {
        let normalized = p.replace(/\//g, '\\');
        normalized = normalized.replace(/\\\\/g, '\\');
        // Allow lowercase for full case insensitivity
        return normalized.toLowerCase();
    }
}
