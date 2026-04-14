import type { WorkspaceContentType } from '../types';

export interface ContentTypeResolutionInput {
    path?: string;
    mimeType?: string;
    artifactType?: string;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp']);
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
    '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.sass', '.sql',
    '.sh', '.bat', '.ps1', '.toml', '.ini', '.log',
]);
const BOARD_EXTENSIONS = new Set(['.board', '.tboard', '.board.json']);

function fileExtension(filePath?: string): string {
    if (!filePath) return '';
    const normalized = filePath.toLowerCase();
    if (normalized.endsWith('.board.json')) return '.board.json';
    const idx = normalized.lastIndexOf('.');
    return idx >= 0 ? normalized.slice(idx) : '';
}

function normalizeMime(mimeType?: string): string {
    return (mimeType || '').toLowerCase().trim();
}

export function resolveWorkspaceContentType(input: ContentTypeResolutionInput): WorkspaceContentType {
    const ext = fileExtension(input.path);
    const mime = normalizeMime(input.mimeType);
    const artifactType = (input.artifactType || '').toLowerCase().trim();

    if (artifactType === 'board') return 'board';
    if (artifactType === 'rtf') return 'rtf';
    if (artifactType === 'pdf') return 'pdf';
    if (artifactType === 'image') return 'image';
    if (artifactType === 'html') return 'html';
    if (artifactType === 'text' || artifactType === 'markdown' || artifactType === 'code' || artifactType === 'editor' || artifactType === 'json') return 'text';

    if (BOARD_EXTENSIONS.has(ext)) return 'board';
    if (ext === '.html' || ext === '.htm') return 'html';
    if (ext === '.rtf') return 'rtf';
    if (ext === '.pdf') return 'pdf';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (TEXT_EXTENSIONS.has(ext)) return 'text';

    if (mime.includes('text/html')) return 'html';
    if (mime.includes('application/rtf') || mime.includes('text/rtf')) return 'rtf';
    if (mime.includes('application/pdf')) return 'pdf';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('text/')) return 'text';
    if (mime.includes('json') || mime.includes('xml') || mime.includes('javascript')) return 'text';

    return 'unknown';
}

