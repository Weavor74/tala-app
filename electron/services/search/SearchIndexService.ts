import * as fs from 'fs';
import * as path from 'path';
import { FileMetadata, SearchScope } from './SearchTypes';

export class SearchIndexService {
    private workspaceDir: string;
    private metadataCache: Map<string, FileMetadata> = new Map();
    private isIndexing: boolean = false;

    // Directories to skip completely (never indexed)
    private readonly IGNORE_DIRS = new Set([
        'node_modules', '.git', 'dist', 'dist-electron', 'build', 'coverage',
        'data', 'memory', 'archive', 'logs', 'temp', 'tmp', 'venv', '.venv',
        'site-packages', '__pycache__', 'Lib', 'bin'
    ]);

    // Binary / non-searchable extensions
    private readonly BINARY_EXTS = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
        '.zip', '.tar', '.gz', '.7z', '.rar',
        '.exe', '.dll', '.so', '.dylib', '.bin',
        '.db', '.sqlite', '.sqlite3', '.log', '.jsonl',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.mp3', '.mp4', '.wav', '.avi', '.mov',
        '.ttf', '.woff', '.woff2', '.eot',
        '.map', '.pyc', '.class'
    ]);

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    public getMetadata(relativePath: string): FileMetadata | undefined {
        return this.metadataCache.get(relativePath);
    }

    public getAllMetadata(): FileMetadata[] {
        return Array.from(this.metadataCache.values());
    }

    public getCacheSize(): number {
        return this.metadataCache.size;
    }

    public clearIndex(): void {
        this.metadataCache.clear();
    }

    public async refreshIndex(timeBudgetMs?: number): Promise<{ discovered: number, timeTaken: number }> {
        if (this.isIndexing) return { discovered: 0, timeTaken: 0 };
        this.isIndexing = true;
        
        const startTime = Date.now();
        let discoveredCount = 0;
        
        try {
            const walk = (dir: string) => {
                if (timeBudgetMs && Date.now() - startTime > timeBudgetMs) return;

                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    return; // Inaccessible dir
                }

                for (const entry of entries) {
                    if (timeBudgetMs && Date.now() - startTime > timeBudgetMs) return;
                    
                    if (this.IGNORE_DIRS.has(entry.name)) continue;
                    // Skip 'data' inside mcp-servers
                    if (entry.name === 'data' && dir.includes('mcp-servers')) continue;
                    
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory()) {
                        walk(fullPath);
                    } else {
                        const relPath = path.relative(this.workspaceDir, fullPath).replace(/\\/g, '/');
                        const ext = path.extname(entry.name).toLowerCase();
                        
                        let stat: fs.Stats;
                        try {
                            stat = fs.statSync(fullPath);
                        } catch (e) {
                            continue;
                        }

                        const cached = this.metadataCache.get(relPath);
                        if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
                            // Needs update or insertion
                            const isBin = this.BINARY_EXTS.has(ext);
                            const isHidden = entry.name.startsWith('.') && entry.name !== '.env';
                            const isGen = relPath.includes('generated') || relPath.endsWith('.min.js') || relPath.endsWith('.bundle.js');
                            
                            let scope: SearchScope = 'active_code';
                            if (relPath.includes('docs/')) scope = 'docs';
                            else if (relPath.includes('.vscode') || ext === '.json' || ext === '.yaml' || ext === '.yml') scope = 'config';
                            
                            this.metadataCache.set(relPath, {
                                path: relPath,
                                filename: entry.name,
                                extension: ext,
                                size: stat.size,
                                mtime: stat.mtimeMs,
                                scope: scope,
                                isBinary: isBin,
                                isGenerated: isGen,
                                isHidden: isHidden
                            });
                        }
                        discoveredCount++;
                    }
                }
            };

            walk(this.workspaceDir);
        } finally {
            this.isIndexing = false;
        }

        return {
            discovered: discoveredCount,
            timeTaken: Date.now() - startTime
        };
    }
}
