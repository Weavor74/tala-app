/**
 * Tala — Bootstrap Module
 * 
 * This module is responsible for early-stage application setup before any Electron
 * UI or services are initialized. Its primary role is to enforce "Local-First" data
 * sovereignty by redirecting Electron's default system paths (userData, temp, etc.)
 * to a local `/data` directory within the application root.
 * 
 * This ensures that all user data, logs, and settings remain portable and
 * isolated from the host operating system's standard application data folders.
 */

/**
 * Electron Startup Bootstrap
 * 
 * This module handles early-stage environment preparation before any other
 * logic runs. Its primary responsibility is to ensure data isolation by
 * redirecting all Electron-specific data paths (userData, appData, etc.)
 * to a local `/data` directory within the application root.
 * 
 * **Key features:**
 * - Redirects `userData` to `./data`.
 * - Propagates the redirected path to other system folders (`appData`, `documents`).
 * - Resolves the local Python runtime path based on the OS.
 */
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { APP_ROOT, localStorageRootPath, STORAGE_DIRECTORY_PATHS } from './services/PathResolver';

// Create local data directory if it doesn't exist
if (!fs.existsSync(localStorageRootPath)) {
    fs.mkdirSync(localStorageRootPath, { recursive: true });
}

// Override Electron's system paths to stay within the local folder
console.log(`[Bootstrap] Force local storage directory: ${localStorageRootPath}`);
app.setPath('userData', localStorageRootPath);
app.setPath('appData', localStorageRootPath);
app.setPath('sessionData', path.join(localStorageRootPath, 'session'));

const DOCUMENTS_DIR = path.join(localStorageRootPath, 'documents');
const TEMP_DIR = path.join(localStorageRootPath, 'temp');
const DOWNLOADS_DIR = path.join(localStorageRootPath, 'downloads');
const SESSION_DIR = path.join(localStorageRootPath, 'session');

// Ensure standard subdirectories exist within the local data root
[DOCUMENTS_DIR, TEMP_DIR, DOWNLOADS_DIR, SESSION_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Canonical Tala-owned directories under app root.
[
    STORAGE_DIRECTORY_PATHS.logs,
    STORAGE_DIRECTORY_PATHS.cache,
    STORAGE_DIRECTORY_PATHS.temp,
    STORAGE_DIRECTORY_PATHS.memory,
    STORAGE_DIRECTORY_PATHS.reflection,
    STORAGE_DIRECTORY_PATHS.diagnostics,
    path.join(APP_ROOT, 'runtime'),
    path.join(APP_ROOT, 'models'),
    path.join(APP_ROOT, 'exports')
].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.setPath('documents', DOCUMENTS_DIR);
app.setPath('temp', TEMP_DIR);
app.setPath('downloads', DOWNLOADS_DIR);

export { localStorageRootPath, APP_ROOT };


