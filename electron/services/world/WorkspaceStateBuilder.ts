/**
 * WorkspaceStateBuilder — Phase 4A: World Model Foundation
 *
 * Builds WorkspaceState for the TalaWorldModel.
 *
 * Responsibilities:
 *   - Resolve workspace root from a provided path.
 *   - Identify known directories by probing the workspace (fs.existsSync — no recursive scan).
 *   - Classify the workspace at a high level (repo, docs_project, mixed, unknown).
 *   - Mark freshness and availability metadata.
 *
 * Design rules:
 *   - Never scans the filesystem recursively — checks known candidate paths only.
 *   - Keeps state compact and summary-oriented.
 *   - Unavailable workspace is represented explicitly, never silently absent.
 *   - recentFiles and activeFiles are supplied by the caller (from app state).
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    WorkspaceState,
    WorkspaceClassification,
    WorldModelSectionMeta,
    WorldModelAvailability,
} from '../../../shared/worldModelTypes';

// ─── Known directory candidates ───────────────────────────────────────────────

/** Candidate directory names that indicate a workspace's characteristics. */
const KNOWN_DIR_CANDIDATES: string[] = [
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
    'local-inference',
];

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Optional input state from the app that may enrich WorkspaceState.
 */
export interface WorkspaceStateInput {
    /** Absolute workspace root path. */
    workspaceRoot: string;
    /** Currently active files from the editor context. */
    activeFiles?: string[];
    /** Recently touched files (relative paths). */
    recentFiles?: string[];
    /** Count of open artifact/notebook tabs. */
    openArtifactCount?: number;
}

/**
 * WorkspaceStateBuilder
 *
 * Produces a WorkspaceState snapshot from a workspace root and optional
 * app-supplied state (active files, recent files, open artifacts).
 *
 * All probing is done with synchronous fs.existsSync calls on known candidate
 * paths — no recursive directory scanning.
 */
export class WorkspaceStateBuilder {
    /**
     * Builds a WorkspaceState from the provided input.
     *
     * @param input - Workspace root and optional app-supplied state.
     * @returns WorkspaceState suitable for inclusion in TalaWorldModel.
     */
    public build(input: WorkspaceStateInput): WorkspaceState {
        const now = new Date().toISOString();
        const { workspaceRoot, activeFiles = [], recentFiles = [], openArtifactCount = 0 } = input;

        let rootResolved = false;
        let knownDirectories: string[] = [];
        let classification: WorkspaceClassification = 'unknown';
        let availability: WorldModelAvailability = 'unavailable';
        let degradedReason: string | undefined;

        try {
            if (workspaceRoot && fs.existsSync(workspaceRoot)) {
                rootResolved = true;
                knownDirectories = this._probeKnownDirectories(workspaceRoot);
                classification = this._classifyWorkspace(knownDirectories);
                availability = 'available';
            } else {
                degradedReason = `Workspace root not found: ${workspaceRoot || '(empty)'}`;
            }
        } catch (e) {
            availability = 'degraded';
            degradedReason = `Error probing workspace: ${String(e).slice(0, 120)}`;
        }

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness: 'fresh',
            availability,
            degradedReason,
        };

        return {
            meta,
            workspaceRoot: workspaceRoot ?? '',
            classification,
            rootResolved,
            knownDirectories,
            recentFiles: recentFiles.slice(0, 20),
            activeFiles: activeFiles.slice(0, 10),
            openArtifactCount,
        };
    }

    /**
     * Builds an unavailable WorkspaceState when no workspace root is known.
     */
    public buildUnavailable(reason: string): WorkspaceState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason,
            },
            workspaceRoot: '',
            classification: 'unknown',
            rootResolved: false,
            knownDirectories: [],
            recentFiles: [],
            activeFiles: [],
            openArtifactCount: 0,
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _probeKnownDirectories(root: string): string[] {
        const found: string[] = [];
        for (const candidate of KNOWN_DIR_CANDIDATES) {
            try {
                if (fs.existsSync(path.join(root, candidate))) {
                    found.push(candidate);
                }
            } catch {
                // Skip silently — probing should never collapse the build.
            }
        }
        return found;
    }

    private _classifyWorkspace(dirs: string[]): WorkspaceClassification {
        const hasCode = dirs.includes('src') || dirs.includes('electron') || dirs.includes('shared');
        const hasDocs = dirs.includes('docs');

        if (hasCode && hasDocs) return 'mixed';
        if (hasCode) return 'repo';
        if (hasDocs) return 'docs_project';
        return 'unknown';
    }
}

/** Module-level singleton. */
export const workspaceStateBuilder = new WorkspaceStateBuilder();
