/**
 * SelfModelBuilder — Phase 1B
 *
 * Assembles a SystemInventoryIndex from the raw ArtifactRecord list
 * produced by SelfModelScanner. Adds enrichment such as export extraction,
 * kind-summary tallying, and commit SHA detection.
 *
 * Also detects the current git commit SHA for drift detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import type {
    SystemInventoryIndex,
    ArtifactRecord,
    ArtifactKind,
} from '../../../shared/selfModelTypes';
import { SelfModelScanner } from './SelfModelScanner';

const execFileAsync = promisify(execFile);

// How many artifacts to scan with export extraction enabled.
// Scanning all TS files for exports is useful but slows builds on large repos.
// Only extract exports for service and brain files (the most useful).
const EXPORT_SCAN_KINDS: ArtifactKind[] = ['service', 'brain', 'ipc_router', 'ipc_handler', 'repository', 'provider', 'entrypoint'];

// ─── SelfModelBuilder ─────────────────────────────────────────────────────────

export class SelfModelBuilder {
    private readonly scanner: SelfModelScanner;
    private readonly repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
        this.scanner = new SelfModelScanner(repoRoot);
    }

    /**
     * Build a complete SystemInventoryIndex by scanning all tracked files.
     * This is the P1B deliverable.
     */
    public async buildIndex(): Promise<SystemInventoryIndex> {
        const files = await this.scanner.listFiles();

        const artifacts: ArtifactRecord[] = [];
        for (const rel of files) {
            const shouldExtractExports = this._shouldExtractExports(rel);
            const record = await this.scanner.scanFile(rel, shouldExtractExports);
            artifacts.push(record);
        }

        // Sort for determinism
        artifacts.sort((a, b) => a.path.localeCompare(b.path));

        const kindSummary = this._buildKindSummary(artifacts);
        const commitSha = await this._getCommitSha();

        return {
            version: '1.0',
            generatedAt: new Date().toISOString(),
            repoRoot: this.repoRoot,
            commitSha: commitSha ?? undefined,
            totalArtifacts: artifacts.length,
            artifacts,
            kindSummary,
        };
    }

    /**
     * Compute a SHA-256 hash of an index for drift detection.
     */
    public static hashIndex(index: SystemInventoryIndex): string {
        // Hash only the path+kind+subsystemId — not mtime/sizeBytes which change often
        const stable = index.artifacts.map(a => `${a.path}|${a.kind}|${a.subsystemId}`).join('\n');
        return createHash('sha256').update(stable).digest('hex');
    }

    /**
     * Load an existing index from disk. Returns null if not found.
     */
    public loadExistingIndex(indexPath: string): SystemInventoryIndex | null {
        try {
            const raw = fs.readFileSync(indexPath, 'utf-8');
            return JSON.parse(raw) as SystemInventoryIndex;
        } catch {
            return null;
        }
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _shouldExtractExports(rel: string): boolean {
        const ext = path.extname(rel).toLowerCase();
        if (ext !== '.ts' && ext !== '.tsx') return false;
        // Don't extract exports for tests, docs, scripts, data
        if (rel.startsWith('tests/') || rel.startsWith('electron/__tests__/')) return false;
        if (rel.startsWith('docs/') || rel.startsWith('scripts/') || rel.startsWith('data/')) return false;
        return true;
    }

    private _buildKindSummary(artifacts: ArtifactRecord[]): Partial<Record<ArtifactKind, number>> {
        const summary: Partial<Record<ArtifactKind, number>> = {};
        for (const a of artifacts) {
            summary[a.kind] = (summary[a.kind] ?? 0) + 1;
        }
        return summary;
    }

    private async _getCommitSha(): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: this.repoRoot });
            return stdout.trim();
        } catch {
            return null;
        }
    }
}
