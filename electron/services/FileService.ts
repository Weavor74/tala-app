import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import { CodeAccessPolicy } from './CodeAccessPolicy';
import { RuntimeErrorLogger } from './logging/RuntimeErrorLogger';
import { APP_ROOT, resolveStoragePath } from './PathResolver';

/**
 * Represents a single file or directory entry within the workspace file tree.
 * Used by the frontend FileExplorer component to render the directory listing.
 */
export interface FileEntry {
    /** The file or directory name (e.g., `'README.md'`, `'src'`). */
    name: string;
    /** Relative path from the workspace root, using forward slashes (e.g., `'src/components/App.tsx'`). */
    path: string;
    /** `true` if this entry is a directory, `false` if it's a file. */
    isDirectory: boolean;
    /** Child entries for directories (populated recursively only if the caller expands the tree). */
    children?: FileEntry[];
}

/**
 * Sandboxed Filesystem Service for the Tala workspace.
 * 
 * The `FileService` provides a secure, path-validated interface for all disk 
 * operations within the active workspace. 
 * 
 * **Core Responsibilities:**
 * - **Sandboxing**: Confines all operations to `workspaceDir` to prevent path traversal.
 * - **Policy Enforcement**: Integrates with `CodeAccessPolicy` for fine-grained read/write permissions.
 * - **File Management**: Standard CRUD operations for files and directories.
 * - **Search**: Implements a lightweight, recursive, case-insensitive content search.
 * - **Watching**: Real-time monitoring of file changes via `chokidar`, relayed to the UI.
 */
export class FileService {
    /** The absolute path to the current workspace root directory. */
    private workspaceDir: string;
    private policy: CodeAccessPolicy | null = null;

    /**
     * Creates a new FileService instance.
     * 
     * Determines the workspace root from the `initialRoot` parameter, falling
     * back to app-root-relative defaults. If the directory doesn't exist, it's
     * created recursively. If creation fails, falls back to `APP_ROOT`.
     * 
     * @param {string} [initialRoot] - Optional explicit workspace root path.
     *   If omitted, the path is determined by the environment.
     */
    constructor(initialRoot?: string) {
        // Default to app root in dev, otherwise to app-local storage workspace.
        const defaultPath = initialRoot || ((process.env.VITE_DEV_SERVER_URL || !app.isPackaged)
            ? APP_ROOT
            : resolveStoragePath('workspace'));

        this.workspaceDir = path.resolve(defaultPath);
        if (!fs.existsSync(this.workspaceDir)) {
            try {
                fs.mkdirSync(this.workspaceDir, { recursive: true });
            } catch (e) {
                console.error(`[FileService] Failed to create workspace at ${this.workspaceDir}`, e);
                // Last-resort fallback remains app-root-relative.
                this.workspaceDir = APP_ROOT;
            }
        }
    }

    public setPolicy(policy: CodeAccessPolicy) {
        this.policy = policy;
        this.workspaceDir = policy.getWorkspaceRoot();
    }

    /**
     * Changes the workspace root to a new directory.
     * 
     * Validates that the path exists and is a directory before updating.
     * If invalid, throws an error and the workspace root remains unchanged.
     * 
     * @param {string} newPath - The new absolute directory path.
     * @returns {string} The updated workspace root path.
     * @throws {Error} If the path doesn't exist or is not a directory.
     */
    public setRoot(newPath: string) {
        if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
            this.workspaceDir = newPath;
            // Restart watcher for new root if it was active
            if (this.watchWindow) {
                this.watchWorkspace(this.watchWindow);
            }
            return this.workspaceDir;
        }
        throw new Error("Invalid directory path");
    }

    /**
     * Returns the current workspace root directory path.
     * 
     * @returns {string} Absolute path to the workspace root.
     */
    public getRoot(): string {
        return this.workspaceDir;
    }

    /**
     * Lists the contents of a directory within the workspace.
     * 
     * Returns an array of `FileEntry` objects, sorted with directories first
     * (alphabetically) followed by files (alphabetically). Invalid entries
     * (e.g., broken symlinks) are silently skipped.
     * 
     * **Security:** Validates that the resolved path is within the workspace root.
     * 
     * @param {string} [dirPath=''] - Relative path from the workspace root.
     *   Empty string lists the root directory itself.
     * @returns {Promise<FileEntry[]>} Array of file/directory entries.
     * @throws {Error} If the path escapes the workspace root or can't be read.
     */
    public async listDirectory(dirPath: string = ''): Promise<FileEntry[]> {
        if (this.policy) {
            const validation = this.policy.validatePath(dirPath, 'read');
            if (!validation.ok) throw new Error(validation.error);
        }

        const fullPath = path.join(this.workspaceDir, dirPath);

        // Security check (fallback if no policy)
        if (!fullPath.startsWith(this.workspaceDir)) {
            throw new Error("Access denied");
        }

        if (!fs.existsSync(fullPath)) {
            return [];
        }

        try {
            // Robust listing handling
            const entries = fs.readdirSync(fullPath, { withFileTypes: true });

            const files: FileEntry[] = entries.map(entry => {
                try {
                    return {
                        name: entry.name,
                        path: path.join(dirPath, entry.name).replace(/\\/g, '/'),
                        isDirectory: entry.isDirectory()
                    };
                } catch (e) {
                    return null; // Skip invalid
                }
            }).filter(f => f !== null) as FileEntry[];

            // Sort: Directories first, then files
            files.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });

            return files;

        } catch (e: any) {
            console.error(`[FileService] Failed to list ${fullPath}:`, e);
            // Return empty list on hard failure instead of crashing, but log it
            throw new Error(`Failed to read directory: ${e.message}`);
        }
    }

    /**
     * Creates a directory at the specified path within the workspace.
     * 
     * Creates parent directories recursively if they don't exist.
     * If the directory already exists, this is a no-op.
     * 
     * @param {string} dirPath - Relative path for the new directory.
     * @returns {Promise<boolean>} Always `true` on success.
     * @throws {Error} If the path escapes the workspace root.
     */
    public async createDirectory(dirPath: string): Promise<boolean> {
        if (this.policy) {
            const validation = this.policy.validatePath(dirPath, 'write');
            if (!validation.ok) throw new Error(validation.error);
        }
        const fullPath = path.join(this.workspaceDir, dirPath);
        if (!fullPath.startsWith(this.workspaceDir)) throw new Error("Access denied");

        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        return true;
    }

    /**
     * Deletes a file or directory at the specified path within the workspace.
     * 
     * Uses `fs.rmSync` with `recursive: true` and `force: true` to handle
     * both files and non-empty directories. If the target doesn't exist,
     * this is a no-op.
     * 
     * @param {string} targetPath - Relative path to the file or directory to delete.
     * @returns {Promise<boolean>} Always `true` on success.
     * @throws {Error} If the path escapes the workspace root or deletion fails
     *   (e.g., file is locked by another process on Windows).
     */
    public async deletePath(targetPath: string): Promise<boolean> {
        if (this.policy) {
            const validation = this.policy.validatePath(targetPath, 'delete');
            if (!validation.ok) throw new Error(validation.error);
        }
        const fullPath = path.join(this.workspaceDir, targetPath);
        if (!fullPath.startsWith(this.workspaceDir)) throw new Error("Access denied");

        if (fs.existsSync(fullPath)) {
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } catch (e: any) {
                // Try unlink if rm fails (sometimes happens on Windows with locked files)
                console.warn("Retrying delete with unlink...", e);
                // fs.unlinkSync(fullPath); // Only for files
                throw e;
            }
        }
        return true;
    }

    /**
     * Creates a new file at the specified path within the workspace.
     * 
     * Overwrites the file if it already exists. Does NOT create parent
     * directories — use `createDirectory` first if needed.
     * 
     * @param {string} filePath - Relative path for the new file.
     * @param {string} [content=''] - Initial file content. Defaults to empty.
     * @returns {Promise<boolean>} Always `true` on success.
     * @throws {Error} If the path escapes the workspace root.
     */
    public async createFile(filePath: string, content: string = ''): Promise<boolean> {
        if (this.policy) {
            const validation = this.policy.validatePath(filePath, 'write');
            if (!validation.ok) throw new Error(validation.error);
        }
        const fullPath = path.join(this.workspaceDir, filePath);
        if (!fullPath.startsWith(this.workspaceDir)) throw new Error("Access denied");

        fs.writeFileSync(fullPath, content);
        return true;
    }

    /**
     * Copies a file or directory from one location to another within the workspace.
     * 
     * If `srcPath` and `destPath` are identical, creates a duplicate with `_copy`
     * appended to the filename (before the extension). Uses `fs.cpSync` with
     * `recursive: true` so directories are copied completely.
     * 
     * @param {string} srcPath - Relative path to the source file or directory.
     * @param {string} destPath - Relative path to the destination.
     * @returns {Promise<boolean>} Always `true` on success.
     * @throws {Error} If paths escape the workspace root, source doesn't exist,
     *   or the copy operation fails.
     */
    public async copyPath(srcPath: string, destPath: string): Promise<boolean> {
        if (this.policy) {
            const vSrc = this.policy.validatePath(srcPath, 'read');
            const vDest = this.policy.validatePath(destPath, 'write');
            if (!vSrc.ok) throw new Error(vSrc.error);
            if (!vDest.ok) throw new Error(vDest.error);
        }
        const fullSrc = path.join(this.workspaceDir, srcPath);
        let fullDest = path.join(this.workspaceDir, destPath);

        if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
            throw new Error("Access denied");
        }

        if (!fs.existsSync(fullSrc)) {
            throw new Error("Source file does not exist");
        }

        // Handle same file copy (Duplicate)
        if (fullSrc === fullDest) {
            const ext = path.extname(fullDest);
            const base = path.basename(fullDest, ext);
            fullDest = path.join(path.dirname(fullDest), `${base}_copy${ext}`);
        }

        try {
            fs.cpSync(fullSrc, fullDest, { recursive: true });
        } catch (e) {
            console.error("Copy failed", e);
            throw e;
        }
        return true;
    }

    /**
     * Moves (renames) a file or directory within the workspace.
     * 
     * First attempts `fs.renameSync` for efficiency. If that fails (e.g.,
     * cross-device move), falls back to copy-then-delete.
     * 
     * @param {string} srcPath - Relative path to the source file or directory.
     * @param {string} destPath - Relative path to the destination.
     * @returns {Promise<boolean>} Always `true` on success.
     * @throws {Error} If paths escape the workspace root or source doesn't exist.
     */
    public async movePath(srcPath: string, destPath: string): Promise<boolean> {
        if (this.policy) {
            const vSrc = this.policy.validatePath(srcPath, 'delete');
            const vDest = this.policy.validatePath(destPath, 'write');
            if (!vSrc.ok) throw new Error(vSrc.error);
            if (!vDest.ok) throw new Error(vDest.error);
        }
        const fullSrc = path.join(this.workspaceDir, srcPath);
        const fullDest = path.join(this.workspaceDir, destPath);

        if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
            throw new Error("Access denied");
        }

        if (!fs.existsSync(fullSrc)) {
            throw new Error("Source file does not exist");
        } else if (fullSrc === fullDest) return true;

        try {
            fs.renameSync(fullSrc, fullDest);
        } catch (e) {
            console.error("Move (rename) failed, attempting Copy+Delete...", e);
            // Fallback for cross-device moves
            fs.cpSync(fullSrc, fullDest, { recursive: true });
            fs.rmSync(fullSrc, { recursive: true, force: true });
        }
        return true;
    }

    /**
     * Reads the full text content of a file within the workspace.
     * 
     * Always reads as UTF-8. Binary files will produce garbled output.
     * 
     * @param {string} filePath - Relative path to the file to read.
     * @returns {Promise<string>} The file's text content.
     * @throws {Error} If the path escapes the workspace root, the file doesn't
     *   exist, or reading fails.
     */
    public async readFile(filePath: string): Promise<string> {
        if (this.policy) {
            const validation = this.policy.validatePath(filePath, 'read');
            if (!validation.ok) throw new Error(validation.error);
        }
        const fullPath = path.join(this.workspaceDir, filePath);

        // Security check
        if (!fullPath.startsWith(this.workspaceDir)) {
            throw new Error("Access denied");
        }

        if (!fs.existsSync(fullPath)) {
            const error = new Error("File not found") as Error & { code?: string };
            error.code = 'FILE_NOT_FOUND';
            RuntimeErrorLogger.log({
                source: 'filesystem',
                component: 'FileService',
                event: 'read-file',
                code: 'FILE_NOT_FOUND',
                message: error.message,
                stack: error.stack,
                metadata: { path: filePath },
            });
            throw error;
        }

        try {
            return fs.readFileSync(fullPath, 'utf-8');
        } catch (e: any) {
            console.error("Read failed", e);
            RuntimeErrorLogger.log({
                source: 'filesystem',
                component: 'FileService',
                event: 'read-file',
                code: 'FILE_READ_ERROR',
                message: e?.message || String(e),
                stack: e?.stack,
                metadata: { path: filePath },
            });
            throw new Error(`Failed to read file: ${e.message}`);
        }
    }

    /**
     * Performs a case-insensitive text search across all files in the workspace.
     * 
     * Recursively walks the workspace directory tree, skipping excluded
     * directories (`node_modules`, `.git`, `dist`, `dist-electron`, `venv`)
     * and binary file extensions (`.png`, `.jpg`, `.pdf`, `.zip`, `.exe`, etc.).
     * Files larger than 1 MB are also skipped for performance.
     * 
     * For each matching file, extracts a context snippet of approximately
     * 200 characters centered on the first occurrence of the query.
     * Results are capped at 50 matches to prevent excessive memory usage.
     * 
     * @param {string} query - The text string to search for (case-insensitive).
     * @returns {Promise<{ path: string, content: string }[]>} Array of match objects
     *   containing the relative file path and a context snippet around the match.
     */
    public async searchFiles(query: string): Promise<{ path: string, content: string }[]> {
        const results: { path: string, content: string }[] = [];
        const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
        const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'dist-electron', 'venv'];
        const EXCLUDED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.exe', '.dll', '.bin'];

        const search = async (dir: string) => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (!EXCLUDED_DIRS.includes(entry.name)) {
                        await search(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (EXCLUDED_EXTS.includes(ext)) continue;

                    try {
                        const stats = await fs.promises.stat(fullPath);
                        if (stats.size > MAX_FILE_SIZE) continue;

                        const content = await fs.promises.readFile(fullPath, 'utf-8');
                        if (content.toLowerCase().includes(query.toLowerCase())) {
                            const relPath = path.relative(this.workspaceDir, fullPath).replace(/\\/g, '/');

                            // Find snippet
                            const idx = content.toLowerCase().indexOf(query.toLowerCase());
                            const start = Math.max(0, idx - 50);
                            const end = Math.min(content.length, idx + 150);
                            const snippet = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');

                            results.push({ path: relPath, content: snippet });
                        }
                    } catch (e) {
                        // Skip unreadable files
                    }
                }

                // Safety break to allow other operations if the list is long
                if (results.length > 50) break;
            }
        };

        try {
            await search(this.workspaceDir);
        } catch (e) {
            console.error("Search failed", e);
        }
        return results;
    }

    // ───────── File Watching ─────────
    private watcher: any | null = null;
    private watchDebounce: NodeJS.Timeout | null = null;
    private watchWindow: Electron.BrowserWindow | null = null;

    /**
     * Starts watching the workspace root for file system changes.
     * 
     * Uses `chokidar` for robust cross-platform recursive watching.
     * Debounced to 500ms to avoid flooding the renderer.
     * When a change is detected, sends `'file-changed'` IPC event.
     *
     * @param {Electron.BrowserWindow} win - The BrowserWindow to send notifications to.
     */
    public watchWorkspace(win: Electron.BrowserWindow) {
        this.watchWindow = win;
        this.stopWatching(); // Close existing watcher if any

        try {
            this.watcher = chokidar.watch(this.workspaceDir, {
                ignored: [
                    /(^|[\/\\])\../, // ignore dotfiles
                    '**/node_modules/**',
                    '**/.git/**',
                    '**/dist/**',
                    '**/bin/**',
                    '**/qdrant/**',
                    '**/venv/**',
                    '**/dist-electron/**',
                    '**/tmp/**',
                    '**/logs/**',
                    '**/*.swp',
                    '**/*~',
                    '**/*.exe',
                    '**/*.dll',
                    '**/*.bin'
                ],
                persistent: true,
                ignoreInitial: true,
                usePolling: true, // Switched to true for Windows stability
                interval: 1000,   // Polling interval
                binaryInterval: 3000,
                awaitWriteFinish: {
                    stabilityThreshold: 1000,
                    pollInterval: 100
                },
                ignorePermissionErrors: true, // STEP 5: Add ignorePermissionErrors
                depth: 9
            });

            const onEvent = (filename: string) => {
                if (this.watchDebounce) clearTimeout(this.watchDebounce);
                this.watchDebounce = setTimeout(() => {
                    if (this.watchWindow && !this.watchWindow.isDestroyed()) {
                        this.watchWindow.webContents.send('file-changed', { path: filename || '' });
                    }
                }, 500);
            };

            this.watcher
                .on('add', onEvent)
                .on('change', onEvent)
                .on('unlink', onEvent)
                .on('addDir', onEvent)
                .on('unlinkDir', onEvent)
                .on('error', (error: any) => {
                    if (error.code === 'EPERM') {
                        console.warn(`[FileService] Watcher EPERM (Locked file/Access denied) at: ${error.path || 'unknown'}`);
                    } else {
                        console.error(`[FileService] Watcher error: ${error}`);
                    }
                });

            console.log(`[FileService] Watching workspace with chokidar: ${this.workspaceDir}`);
        } catch (e) {
            console.error('[FileService] Failed to start chokidar watcher:', e);
        }
    }

    /**
     * Stops watching the workspace for changes.
     */
    public stopWatching() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.watchDebounce) {
            clearTimeout(this.watchDebounce);
            this.watchDebounce = null;
        }
    }
}
