/**
 * SelfModelScanner — Phase 1B
 *
 * Deterministic, heuristic-first file scanner for the self-model index.
 * Enumerates all tracked files via `git ls-files` (with fs-walk fallback),
 * classifies each file by path/name conventions, and emits ArtifactRecord
 * objects for the SelfModelBuilder to assemble into a SystemInventoryIndex.
 *
 * Design rules:
 * - No AST parsing. Classification is path-based and name-pattern-based only.
 * - Deterministic: same input → same output, always.
 * - Graceful degradation: git unavailable → fs walk; any error → partial index.
 * - No network calls. No LLM. No cloud.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ArtifactKind, ArtifactRecord } from '../../../shared/selfModelTypes';

const execFileAsync = promisify(execFile);

// ─── Classification helpers ───────────────────────────────────────────────────

interface Classification {
    kind: ArtifactKind;
    subsystemId: string;
    tags: string[];
    isEntrypoint: boolean;
}

/** Derive MCP subsystem id from path. e.g. mcp-servers/astro-engine/ → mcp-astro */
function getMcpSubsystem(rel: string): string {
    const m = rel.match(/^mcp-servers\/([^/]+)/);
    if (!m) return 'mcp';
    const name = m[1].replace(/^tala-/, '');
    return `mcp-${name}`;
}

/**
 * Classify a single relative file path.
 * Rules are checked in order; first matching rule wins.
 */
function classifyPath(rel: string): Classification {
    // ── Entrypoints ─────────────────────────────────────────────────────────────
    if (rel === 'electron/main.ts' || rel === 'electron/preload.ts' ||
        rel === 'electron/bootstrap.ts' || rel === 'electron/browser-preload.ts') {
        return { kind: 'entrypoint', subsystemId: 'electron-main', tags: ['entrypoint', 'electron'], isEntrypoint: true };
    }

    // ── IPC Router ───────────────────────────────────────────────────────────────
    if (rel === 'electron/services/IpcRouter.ts') {
        return { kind: 'ipc_router', subsystemId: 'electron-main', tags: ['ipc', 'routing', 'electron'], isEntrypoint: true };
    }

    // ── IPC handler files (AppService pattern) ───────────────────────────────────
    if (rel.startsWith('electron/') && /AppService\.ts$/.test(rel)) {
        return { kind: 'ipc_handler', subsystemId: deriveSubsystemFromPath(rel), tags: ['ipc', 'handler', 'electron'], isEntrypoint: false };
    }

    // ── Electron services by sub-directory ──────────────────────────────────────
    if (rel.startsWith('electron/services/reflection/')) {
        return { kind: 'service', subsystemId: 'reflection', tags: ['service', 'reflection', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/soul/')) {
        return { kind: 'service', subsystemId: 'soul', tags: ['service', 'soul', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/maintenance/')) {
        return { kind: 'service', subsystemId: 'maintenance', tags: ['service', 'maintenance', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/retrieval/')) {
        const kind: ArtifactKind = /Provider\.ts$/.test(rel) ? 'provider' : (/Repository\.ts$/.test(rel) ? 'repository' : 'service');
        return { kind, subsystemId: 'retrieval', tags: ['service', 'retrieval', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/context/')) {
        return { kind: 'service', subsystemId: 'context-assembly', tags: ['service', 'context', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/router/')) {
        return { kind: 'service', subsystemId: 'context-assembly', tags: ['service', 'router', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/cognitive/')) {
        return { kind: 'service', subsystemId: 'inference', tags: ['service', 'cognitive', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/inference/')) {
        return { kind: 'service', subsystemId: 'inference', tags: ['service', 'inference', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/memory/')) {
        return { kind: 'service', subsystemId: 'memory', tags: ['service', 'memory', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/graph/')) {
        return { kind: 'service', subsystemId: 'memory', tags: ['service', 'graph', 'memory', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/embedding/')) {
        return { kind: 'service', subsystemId: 'memory', tags: ['service', 'embedding', 'memory', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/db/')) {
        const kind: ArtifactKind = /Repository\.ts$/.test(rel) ? 'repository' : 'service';
        return { kind, subsystemId: 'memory', tags: ['database', 'memory', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/policy/')) {
        return { kind: 'service', subsystemId: 'memory', tags: ['service', 'policy', 'memory', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/plan/')) {
        return { kind: 'service', subsystemId: 'inference', tags: ['service', 'plan', 'prompt', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/ingestion/')) {
        return { kind: 'service', subsystemId: 'retrieval', tags: ['service', 'ingestion', 'retrieval', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/search/')) {
        return { kind: 'service', subsystemId: 'retrieval', tags: ['service', 'search', 'retrieval', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/world/')) {
        return { kind: 'service', subsystemId: 'world-model', tags: ['service', 'world', 'electron'], isEntrypoint: false };
    }
    if (rel.startsWith('electron/services/selfModel/')) {
        return { kind: 'service', subsystemId: 'self-model', tags: ['service', 'self-model', 'electron'], isEntrypoint: false };
    }
    // Top-level electron services (no sub-directory beyond services/)
    if (rel.startsWith('electron/services/') && rel.split('/').length === 3) {
        return { kind: 'service', subsystemId: 'electron-main', tags: ['service', 'electron'], isEntrypoint: false };
    }
    // Any other electron/services/** file
    if (rel.startsWith('electron/services/')) {
        return { kind: 'service', subsystemId: 'electron-main', tags: ['service', 'electron'], isEntrypoint: false };
    }

    // ── Brains ───────────────────────────────────────────────────────────────────
    if (rel.startsWith('electron/brains/')) {
        return { kind: 'brain', subsystemId: 'inference', tags: ['brain', 'inference', 'electron'], isEntrypoint: false };
    }
    // ── Migrations ───────────────────────────────────────────────────────────────
    if (rel.startsWith('electron/migrations/')) {
        return { kind: 'migration', subsystemId: 'memory', tags: ['migration', 'database', 'electron'], isEntrypoint: false };
    }
    // ── Electron types ───────────────────────────────────────────────────────────
    if (rel.startsWith('electron/types/')) {
        return { kind: 'shared_contract', subsystemId: 'electron-main', tags: ['types', 'electron'], isEntrypoint: false };
    }
    // ── Electron __tests__ ───────────────────────────────────────────────────────
    if (rel.startsWith('electron/__tests__/')) {
        return { kind: 'test', subsystemId: 'tests', tags: ['test', 'electron'], isEntrypoint: false };
    }

    // ── Renderer ─────────────────────────────────────────────────────────────────
    if (rel.startsWith('src/renderer/components/')) {
        return { kind: 'renderer_component', subsystemId: 'renderer', tags: ['component', 'renderer'], isEntrypoint: false };
    }
    if (rel.startsWith('src/renderer/utils/')) {
        return { kind: 'renderer_util', subsystemId: 'renderer', tags: ['util', 'renderer'], isEntrypoint: false };
    }
    if (rel.startsWith('src/renderer/') && /[Tt]ypes?\.(ts|tsx)$/.test(rel)) {
        return { kind: 'renderer_type', subsystemId: 'renderer', tags: ['types', 'renderer'], isEntrypoint: false };
    }
    if (rel.startsWith('src/')) {
        return { kind: 'renderer_component', subsystemId: 'renderer', tags: ['renderer'], isEntrypoint: false };
    }

    // ── Shared contracts ─────────────────────────────────────────────────────────
    if (rel.startsWith('shared/')) {
        return { kind: 'shared_contract', subsystemId: 'shared', tags: ['contract', 'shared'], isEntrypoint: false };
    }

    // ── MCP servers ──────────────────────────────────────────────────────────────
    if (rel.startsWith('mcp-servers/')) {
        return { kind: 'mcp_server', subsystemId: getMcpSubsystem(rel), tags: ['mcp'], isEntrypoint: rel.endsWith('/main.py') || rel.endsWith('/main.ts') };
    }

    // ── Local inference ──────────────────────────────────────────────────────────
    if (rel.startsWith('local-inference/')) {
        return { kind: 'inference_server', subsystemId: 'local-inference', tags: ['inference', 'local'], isEntrypoint: rel.endsWith('/main.py') || rel.endsWith('/app.py') };
    }

    // ── Tests ────────────────────────────────────────────────────────────────────
    if (rel.startsWith('tests/')) {
        return { kind: 'test', subsystemId: 'tests', tags: ['test'], isEntrypoint: false };
    }

    // ── Scripts ──────────────────────────────────────────────────────────────────
    if (rel.startsWith('scripts/')) {
        return { kind: 'script', subsystemId: 'scripts', tags: ['script'], isEntrypoint: false };
    }

    // ── Docs ─────────────────────────────────────────────────────────────────────
    if (rel.startsWith('docs/')) {
        return { kind: 'doc', subsystemId: 'docs', tags: ['doc'], isEntrypoint: false };
    }

    // ── Tools ────────────────────────────────────────────────────────────────────
    if (rel.startsWith('tools/')) {
        return { kind: 'script', subsystemId: 'tools', tags: ['tool'], isEntrypoint: false };
    }

    // ── Data files ───────────────────────────────────────────────────────────────
    if (rel.startsWith('data/')) {
        return { kind: 'data_file', subsystemId: 'electron-main', tags: ['data'], isEntrypoint: false };
    }

    // ── Root config files ────────────────────────────────────────────────────────
    if (!rel.includes('/') && (/\.(json|yml|yaml|toml|env)$/.test(rel) || rel.endsWith('.config.ts') || rel.endsWith('.config.js') || rel === '.gitignore' || rel === '.eslintrc')) {
        return { kind: 'config', subsystemId: 'scripts', tags: ['config', 'root'], isEntrypoint: false };
    }

    return { kind: 'unknown', subsystemId: 'unknown', tags: [], isEntrypoint: false };
}

/** Derive subsystem id from a service file path (best-effort). */
function deriveSubsystemFromPath(rel: string): string {
    if (rel.startsWith('electron/services/reflection/')) return 'reflection';
    if (rel.startsWith('electron/services/soul/')) return 'soul';
    if (rel.startsWith('electron/services/maintenance/')) return 'maintenance';
    if (rel.startsWith('electron/services/selfModel/')) return 'self-model';
    if (rel.startsWith('electron/services/retrieval/')) return 'retrieval';
    if (rel.startsWith('electron/services/context/') || rel.startsWith('electron/services/router/')) return 'context-assembly';
    if (rel.startsWith('electron/services/cognitive/') || rel.startsWith('electron/services/inference/') || rel.startsWith('electron/services/plan/')) return 'inference';
    if (rel.startsWith('electron/services/memory/') || rel.startsWith('electron/services/db/') || rel.startsWith('electron/services/embedding/') || rel.startsWith('electron/services/graph/') || rel.startsWith('electron/services/policy/')) return 'memory';
    if (rel.startsWith('electron/services/world/')) return 'world-model';
    return 'electron-main';
}

// ─── Export extraction ────────────────────────────────────────────────────────

/** Extract top-level export names via lightweight regex scan. */
function extractExports(content: string): string[] {
    const exports: string[] = [];
    const re = /^export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Z][a-zA-Z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        if (!exports.includes(m[1])) exports.push(m[1]);
    }
    return exports;
}

// ─── SelfModelScanner ─────────────────────────────────────────────────────────

export class SelfModelScanner {
    private readonly repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
    }

    /**
     * Enumerate all tracked source files.
     * Prefers `git ls-files`; falls back to recursive fs walk on failure.
     */
    public async listFiles(): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
                cwd: this.repoRoot,
                maxBuffer: 10 * 1024 * 1024,
            });
            return stdout.split('\n').filter(l => l.trim() !== '' && this._isSourceFile(l.trim()));
        } catch {
            return this._walkFsFiles();
        }
    }

    /**
     * Classify a single relative path into an ArtifactRecord.
     */
    public classifyFile(relativePath: string, stats?: fs.Stats): ArtifactRecord {
        const rel = relativePath.replace(/\\/g, '/');
        const cls = classifyPath(rel);

        // Add filename-based tags
        const basename = path.basename(rel, path.extname(rel));
        const extraTags: string[] = [];
        if (basename.endsWith('Service')) extraTags.push('service');
        if (basename.endsWith('Router')) extraTags.push('router');
        if (basename.endsWith('Provider')) extraTags.push('provider');
        if (basename.endsWith('Repository')) extraTags.push('repository');

        const uniqueTags = [...new Set([...cls.tags, ...extraTags])];

        return {
            path: rel,
            kind: cls.kind,
            subsystemId: cls.subsystemId,
            tags: uniqueTags,
            isEntrypoint: cls.isEntrypoint,
            isProtected: false,
            exports: undefined,
            associatedTests: this._findAssociatedTests(rel),
            associatedDocs: this._findAssociatedDocs(rel),
            associatedConfig: undefined,
            sizeBytes: stats?.size,
            lastModifiedMs: stats ? stats.mtimeMs : undefined,
        };
    }

    /**
     * Scan and classify a file, optionally reading content for export extraction.
     */
    public async scanFile(relativePath: string, readExports = false): Promise<ArtifactRecord> {
        const fullPath = path.join(this.repoRoot, relativePath);

        let stats: fs.Stats | undefined;
        try {
            stats = fs.statSync(fullPath);
        } catch {
            // file might not exist on disk
        }

        const record = this.classifyFile(relativePath, stats);

        if (readExports && (relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'))) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                record.exports = extractExports(content);
            } catch {
                // not fatal
            }
        }

        return record;
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _isSourceFile(rel: string): boolean {
        const ext = path.extname(rel).toLowerCase();
        const skip = ['.exe', '.dll', '.pyd', '.so', '.node', '.png', '.jpg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.wav', '.bin', '.pyc'];
        if (skip.includes(ext)) return false;
        if (rel.startsWith('node_modules/') || rel.startsWith('dist/') || rel.startsWith('dist-electron/')) return false;
        if (rel.includes('/.git/') || rel === '.git') return false;
        return true;
    }

    private _findAssociatedTests(rel: string): string[] {
        const base = path.basename(rel, path.extname(rel));
        const matches: string[] = [];
        if (base.length < 4) return matches;

        const testsDir = path.join(this.repoRoot, 'tests');
        if (fs.existsSync(testsDir)) {
            try {
                for (const f of fs.readdirSync(testsDir)) {
                    if (f.includes(base) && f.endsWith('.test.ts')) {
                        matches.push(`tests/${f}`);
                    }
                }
            } catch { /* ignore */ }
        }

        const electronTests = path.join(this.repoRoot, 'electron/__tests__');
        if (fs.existsSync(electronTests)) {
            try {
                for (const f of fs.readdirSync(electronTests)) {
                    if (f.includes(base) && f.endsWith('.test.ts')) {
                        matches.push(`electron/__tests__/${f}`);
                    }
                }
            } catch { /* ignore */ }
        }

        return matches;
    }

    private _findAssociatedDocs(rel: string): string[] {
        const base = path.basename(rel, path.extname(rel)).toLowerCase();
        const matches: string[] = [];

        const docsDir = path.join(this.repoRoot, 'docs');
        if (fs.existsSync(docsDir)) {
            try {
                for (const sub of fs.readdirSync(docsDir)) {
                    const stat = fs.statSync(path.join(docsDir, sub));
                    if (stat.isFile() && sub.toLowerCase().includes(base)) {
                        matches.push(`docs/${sub}`);
                    }
                }
            } catch { /* ignore */ }
        }

        return matches;
    }

    private _walkFsFiles(): string[] {
        const results: string[] = [];
        const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.cache', '__pycache__', '.venv', 'venv']);

        const walk = (dir: string) => {
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        if (!SKIP_DIRS.has(entry.name)) {
                            walk(path.join(dir, entry.name));
                        }
                    } else if (entry.isFile()) {
                        const full = path.join(dir, entry.name);
                        const rel = path.relative(this.repoRoot, full).replace(/\\/g, '/');
                        if (this._isSourceFile(rel)) {
                            results.push(rel);
                        }
                    }
                }
            } catch { /* ignore permission errors */ }
        };

        walk(this.repoRoot);
        return results;
    }
}

