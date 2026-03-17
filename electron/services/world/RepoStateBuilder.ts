/**
 * RepoStateBuilder — Phase 4A: World Model Foundation
 *
 * Builds RepoState for the TalaWorldModel.
 *
 * Responsibilities:
 *   - Detect whether a valid Git repository is present at the workspace root.
 *   - Retrieve current branch name and dirty/clean state via GitService.
 *   - Probe key directories to classify the project type.
 *   - Cache the result for a bounded freshness window to avoid over-querying git.
 *   - Represent unavailable or errored git state explicitly.
 *
 * Design rules:
 *   - Does NOT query full git log — only branch, status, and directory probing.
 *   - Uses a freshness cache so the model is not rebuilt on every minor event.
 *   - Unavailable source-control state is explicit, never silently absent.
 *   - Keeps state summary-oriented.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    RepoState,
    RepoProjectType,
    WorldModelSectionMeta,
    WorldModelAvailability,
    WorldModelFreshness,
} from '../../../shared/worldModelTypes';
import type { GitService } from '../GitService';

// ─── Key directory candidates ─────────────────────────────────────────────────

const REPO_DIR_CANDIDATES: string[] = [
    'src',
    'electron',
    'shared',
    'docs',
    'tests',
    'scripts',
    'public',
    'mcp-servers',
    'archive',
    'tools',
];

// ─── Cached result ─────────────────────────────────────────────────────────────

interface CachedRepoState {
    state: RepoState;
    builtAt: number;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * RepoStateBuilder
 *
 * Produces a RepoState snapshot from the workspace root and GitService.
 * Results are cached for a bounded freshness window (default: 30 seconds) to
 * avoid repeated git queries on every world-model assembly.
 */
export class RepoStateBuilder {
    private _cache: CachedRepoState | null = null;
    private readonly _maxCacheAgeMs: number;

    constructor(maxCacheAgeMs = 30_000) {
        this._maxCacheAgeMs = maxCacheAgeMs;
    }

    /**
     * Builds or returns a cached RepoState.
     *
     * @param repoRoot - Absolute path of the workspace/repo root.
     * @param gitService - Optional GitService instance for branch/status queries.
     * @param forceRefresh - If true, bypass the cache.
     * @returns RepoState suitable for inclusion in TalaWorldModel.
     */
    public async build(
        repoRoot: string,
        gitService?: GitService,
        forceRefresh = false,
    ): Promise<RepoState> {
        if (!forceRefresh && this._isCacheValid()) {
            return this._cache!.state;
        }

        const state = await this._buildFresh(repoRoot, gitService);
        this._cache = { state, builtAt: Date.now() };
        return state;
    }

    /**
     * Builds an unavailable RepoState when git state cannot be determined.
     */
    public buildUnavailable(repoRoot: string, reason: string): RepoState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason,
            },
            repoRoot: repoRoot ?? '',
            isRepo: false,
            isDirty: false,
            changedFileCount: 0,
            projectType: 'unknown',
            detectedDirectories: [],
            hasArchitectureDocs: false,
            hasIndexedDocs: false,
        };
    }

    /** Invalidate the internal cache (e.g. after a commit or branch change). */
    public invalidateCache(): void {
        this._cache = null;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _isCacheValid(): boolean {
        if (!this._cache) return false;
        return Date.now() - this._cache.builtAt < this._maxCacheAgeMs;
    }

    private async _buildFresh(repoRoot: string, gitService?: GitService): Promise<RepoState> {
        const now = new Date().toISOString();
        let isRepo = false;
        let branch: string | undefined;
        let isDirty = false;
        let changedFileCount = 0;
        let availability: WorldModelAvailability = 'unavailable';
        let freshness: WorldModelFreshness = 'unknown';
        let degradedReason: string | undefined;

        // Detect repo from .git presence first (cheap check).
        try {
            if (repoRoot && fs.existsSync(path.join(repoRoot, '.git'))) {
                isRepo = true;
            }
        } catch {
            // Fall through — isRepo stays false.
        }

        // Probe git state via GitService if available.
        if (isRepo && gitService) {
            try {
                branch = await gitService.getCurrentBranch();
            } catch {
                branch = undefined;
            }

            try {
                const statusItems = await gitService.getStatus();
                changedFileCount = statusItems.length;
                isDirty = changedFileCount > 0;
            } catch {
                // Git status unavailable — mark as partial.
                availability = 'partial';
                degradedReason = 'Git status unavailable';
            }

            if (availability !== 'partial') {
                availability = 'available';
            }
            freshness = 'fresh';
        } else if (isRepo) {
            // Repo detected but no GitService — partial state.
            availability = 'partial';
            freshness = 'unknown';
            degradedReason = 'GitService not available — branch/status unknown';
        } else if (repoRoot) {
            availability = 'partial';
            freshness = 'unknown';
            degradedReason = 'No .git directory detected at workspace root';
        } else {
            degradedReason = 'No workspace root provided';
        }

        // Probe directories (safe, sync, bounded).
        const detectedDirectories = this._probeDirectories(repoRoot);
        const hasArchitectureDocs = fs.existsSync(path.join(repoRoot, 'docs'));
        const hasIndexedDocs = fs.existsSync(path.join(repoRoot, 'docs', 'architecture'));

        const projectType = this._classifyProject(detectedDirectories);

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness,
            availability,
            degradedReason,
        };

        return {
            meta,
            repoRoot: repoRoot ?? '',
            isRepo,
            branch,
            isDirty,
            changedFileCount,
            projectType,
            detectedDirectories,
            hasArchitectureDocs,
            hasIndexedDocs,
        };
    }

    private _probeDirectories(root: string): string[] {
        if (!root) return [];
        const found: string[] = [];
        for (const candidate of REPO_DIR_CANDIDATES) {
            try {
                if (fs.existsSync(path.join(root, candidate))) {
                    found.push(candidate);
                }
            } catch {
                // Skip silently.
            }
        }
        return found;
    }

    private _classifyProject(dirs: string[]): RepoProjectType {
        const hasElectron = dirs.includes('electron');
        const hasSrc = dirs.includes('src');
        const hasDocs = dirs.includes('docs');
        const hasDocsOnly = hasDocs && !hasSrc && !hasElectron;

        if (hasElectron && hasSrc) return 'electron_app';
        if (hasDocsOnly) return 'docs_only';
        if (hasSrc) return 'node_library';
        if (hasDocs) return 'mixed';
        return 'unknown';
    }
}

/** Module-level singleton (default 30s cache). */
export const repoStateBuilder = new RepoStateBuilder();
