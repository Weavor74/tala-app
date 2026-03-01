import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// Use a dynamic root to ensure portability even if the folder is moved
const APP_ROOT = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : app.getAppPath();

const LOCAL_DATA_DIR = path.join(APP_ROOT, 'data');

// Create local data directory if it doesn't exist
if (!fs.existsSync(LOCAL_DATA_DIR)) {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
}

// Override Electron's system paths to stay within the local folder
console.log(`[Bootstrap] Force local storage directory: ${LOCAL_DATA_DIR}`);
app.setPath('userData', LOCAL_DATA_DIR);

const DOCUMENTS_DIR = path.join(LOCAL_DATA_DIR, 'documents');
const TEMP_DIR = path.join(LOCAL_DATA_DIR, 'temp');
const DOWNLOADS_DIR = path.join(LOCAL_DATA_DIR, 'downloads');

[DOCUMENTS_DIR, TEMP_DIR, DOWNLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.setPath('documents', DOCUMENTS_DIR);
app.setPath('temp', TEMP_DIR);
app.setPath('downloads', DOWNLOADS_DIR);

export { LOCAL_DATA_DIR, APP_ROOT };
