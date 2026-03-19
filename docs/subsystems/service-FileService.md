# Service: FileService.ts

**Source**: [electron\services\FileService.ts](../../electron/services/FileService.ts)

## Class: `FileService`

## Overview
Represents a single file or directory entry within the workspace file tree. Used by the frontend FileExplorer component to render the directory listing./
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

/** Sandboxed Filesystem Service for the Tala workspace.  The `FileService` provides a secure, path-validated interface for all disk  operations within the active workspace.   **Core Responsibilities:** - **Sandboxing**: Confines all operations to `workspaceDir` to prevent path traversal. - **Policy Enforcement**: Integrates with `CodeAccessPolicy` for fine-grained read/write permissions. - **File Management**: Standard CRUD operations for files and directories. - **Search**: Implements a lightweight, recursive, case-insensitive content search. - **Watching**: Real-time monitoring of file changes via `chokidar`, relayed to the UI.

### Methods

#### `setPolicy`
**Arguments**: `policy: CodeAccessPolicy`

---
#### `setRoot`
Changes the workspace root to a new directory.  Validates that the path exists and is a directory before updating. If invalid, throws an error and the workspace root remains unchanged.  @param {string} newPath - The new absolute directory path. @returns {string} The updated workspace root path. @throws {Error} If the path doesn't exist or is not a directory./

**Arguments**: `newPath: string`

---
#### `getRoot`
Returns the current workspace root directory path.  @returns {string} Absolute path to the workspace root./

**Arguments**: ``
**Returns**: `string`

---
#### `listDirectory`
Lists the contents of a directory within the workspace.  Returns an array of `FileEntry` objects, sorted with directories first (alphabetically) followed by files (alphabetically). Invalid entries (e.g., broken symlinks) are silently skipped.  **Security:** Validates that the resolved path is within the workspace root.  @param {string} [dirPath=''] - Relative path from the workspace root.   Empty string lists the root directory itself. @returns {Promise<FileEntry[]>} Array of file/directory entries. @throws {Error} If the path escapes the workspace root or can't be read./

**Arguments**: `dirPath: string = ''`
**Returns**: `Promise<FileEntry[]>`

---
#### `createDirectory`
Creates a directory at the specified path within the workspace.  Creates parent directories recursively if they don't exist. If the directory already exists, this is a no-op.  @param {string} dirPath - Relative path for the new directory. @returns {Promise<boolean>} Always `true` on success. @throws {Error} If the path escapes the workspace root./

**Arguments**: `dirPath: string`
**Returns**: `Promise<boolean>`

---
#### `deletePath`
Deletes a file or directory at the specified path within the workspace.  Uses `fs.rmSync` with `recursive: true` and `force: true` to handle both files and non-empty directories. If the target doesn't exist, this is a no-op.  @param {string} targetPath - Relative path to the file or directory to delete. @returns {Promise<boolean>} Always `true` on success. @throws {Error} If the path escapes the workspace root or deletion fails   (e.g., file is locked by another process on Windows)./

**Arguments**: `targetPath: string`
**Returns**: `Promise<boolean>`

---
#### `createFile`
Creates a new file at the specified path within the workspace.  Overwrites the file if it already exists. Does NOT create parent directories — use `createDirectory` first if needed.  @param {string} filePath - Relative path for the new file. @param {string} [content=''] - Initial file content. Defaults to empty. @returns {Promise<boolean>} Always `true` on success. @throws {Error} If the path escapes the workspace root./

**Arguments**: `filePath: string, content: string = ''`
**Returns**: `Promise<boolean>`

---
#### `copyPath`
Copies a file or directory from one location to another within the workspace.  If `srcPath` and `destPath` are identical, creates a duplicate with `_copy` appended to the filename (before the extension). Uses `fs.cpSync` with `recursive: true` so directories are copied completely.  @param {string} srcPath - Relative path to the source file or directory. @param {string} destPath - Relative path to the destination. @returns {Promise<boolean>} Always `true` on success. @throws {Error} If paths escape the workspace root, source doesn't exist,   or the copy operation fails./

**Arguments**: `srcPath: string, destPath: string`
**Returns**: `Promise<boolean>`

---
#### `movePath`
Moves (renames) a file or directory within the workspace.  First attempts `fs.renameSync` for efficiency. If that fails (e.g., cross-device move), falls back to copy-then-delete.  @param {string} srcPath - Relative path to the source file or directory. @param {string} destPath - Relative path to the destination. @returns {Promise<boolean>} Always `true` on success. @throws {Error} If paths escape the workspace root or source doesn't exist./

**Arguments**: `srcPath: string, destPath: string`
**Returns**: `Promise<boolean>`

---
#### `readFile`
Reads the full text content of a file within the workspace.  Always reads as UTF-8. Binary files will produce garbled output.  @param {string} filePath - Relative path to the file to read. @returns {Promise<string>} The file's text content. @throws {Error} If the path escapes the workspace root, the file doesn't   exist, or reading fails./

**Arguments**: `filePath: string`
**Returns**: `Promise<string>`

---
#### `searchFiles`
Performs a case-insensitive text search across all files in the workspace.  Recursively walks the workspace directory tree, skipping excluded directories (`node_modules`, `.git`, `dist`, `dist-electron`, `venv`) and binary file extensions (`.png`, `.jpg`, `.pdf`, `.zip`, `.exe`, etc.). Files larger than 1 MB are also skipped for performance.  For each matching file, extracts a context snippet of approximately 200 characters centered on the first occurrence of the query. Results are capped at 50 matches to prevent excessive memory usage.  @param {string} query - The text string to search for (case-insensitive). @returns {Promise<{ path: string, content: string }[]>} Array of match objects   containing the relative file path and a context snippet around the match./

**Arguments**: `query: string`
**Returns**: `Promise<`

---
#### `watchWorkspace`
Starts watching the workspace root for file system changes.  Uses `chokidar` for robust cross-platform recursive watching. Debounced to 500ms to avoid flooding the renderer. When a change is detected, sends `'file-changed'` IPC event. @param {Electron.BrowserWindow} win - The BrowserWindow to send notifications to./

**Arguments**: `win: Electron.BrowserWindow`

---
#### `stopWatching`
Stops watching the workspace for changes./

**Arguments**: ``

---
