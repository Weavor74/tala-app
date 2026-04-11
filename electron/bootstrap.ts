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
import { APP_ROOT, LOCAL_DATA_DIR, DATA_DIRS } from './services/PathResolver';

// Create local data directory if it doesn't exist
if (!fs.existsSync(LOCAL_DATA_DIR)) {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}

// Override Electron's system paths to stay within the local folder
console.log(`[Bootstrap] Force local storage directory: ${LOCAL_DATA_DIR}`);
app.setPath('userData', LOCAL_DATA_DIR);
app.setPath('appData', LOCAL_DATA_DIR);
app.setPath('sessionData', path.join(LOCAL_DATA_DIR, 'session'));

const DOCUMENTS_DIR = path.join(LOCAL_DATA_DIR, 'documents');
const TEMP_DIR = path.join(LOCAL_DATA_DIR, 'temp');
const DOWNLOADS_DIR = path.join(LOCAL_DATA_DIR, 'downloads');
const SESSION_DIR = path.join(LOCAL_DATA_DIR, 'session');

// Ensure standard subdirectories exist within the local data root
[DOCUMENTS_DIR, TEMP_DIR, DOWNLOADS_DIR, SESSION_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Canonical Tala-owned directories under app root.
[
    DATA_DIRS.logs,
    DATA_DIRS.cache,
    DATA_DIRS.temp,
    DATA_DIRS.memory,
    DATA_DIRS.reflection,
    DATA_DIRS.diagnostics,
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

export { LOCAL_DATA_DIR, APP_ROOT };
