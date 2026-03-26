/**
 * SelfModelRefreshService — Phase 1H
 *
 * Orchestrates the full self-model refresh cycle:
 * 1. Build the SystemInventoryIndex (SelfModelBuilder / P1B).
 * 2. Build the SubsystemOwnershipMap (OwnershipMapper / P1C).
 * 3. Load the InvariantRegistry (P1D).
 * 4. Load the CapabilityRegistry (P1E).
 * 5. Update the SelfModelQueryService with fresh data.
 * 6. Write artifacts to data/self_model/ atomically.
 * 7. Detect drift by comparing hashes with the previous meta.
 * 8. Emit telemetry events.
 *
 * Drift detection:
 * - Compares SHA-256 hashes of path+kind+subsystemId (stable, mtime-independent).
 * - Detects new/removed files and classification changes.
 * - Staleness: age > FRESHNESS_WINDOW_MS since last generatedAt.
 *
 * Design rules:
 * - No network calls. No LLM. No cloud.
 * - Graceful: any step failure degrades to partial refresh, not crash.
 * - Atomic writes: write to .tmp file then rename.
 */

import * as fs from 'fs';
import * as path from 'path';
import { telemetry } from '../TelemetryService';
import type {
    SystemInventoryIndex,
    OwnershipMap,
    SelfModelMeta,
    SelfModelHealthStatus,
} from '../../../shared/selfModelTypes';
import { SelfModelBuilder } from './SelfModelBuilder';
import { OwnershipMapper } from './OwnershipMapper';
import { InvariantRegistry } from './InvariantRegistry';
import { CapabilityRegistry } from './CapabilityRegistry';
import { SelfModelQueryService } from './SelfModelQueryService';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long until a generated self-model is considered stale (24 hours). */
const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

const VERSION = '1.0';

// ─── SelfModelRefreshService ──────────────────────────────────────────────────

export class SelfModelRefreshService {
    private readonly dataDir: string;
    private readonly repoRoot: string;
    private readonly builder: SelfModelBuilder;
    private readonly mapper: OwnershipMapper;
    private readonly invariantRegistry: InvariantRegistry;
    private readonly capabilityRegistry: CapabilityRegistry;
    private queryService: SelfModelQueryService | null = null;

    private lastIndex: SystemInventoryIndex | null = null;
    private lastOwnershipMap: OwnershipMap | null = null;
    private lastMeta: SelfModelMeta | null = null;

    constructor(repoRoot: string, dataDir: string) {
        this.repoRoot = repoRoot;
        this.dataDir = dataDir;
        this.builder = new SelfModelBuilder(repoRoot);
        this.mapper = new OwnershipMapper(repoRoot);
        // Load registries from data dir (hand-authored files)
        this.invariantRegistry = new InvariantRegistry(dataDir);
        this.capabilityRegistry = new CapabilityRegistry(dataDir);
    }

    // ─── Initialization ────────────────────────────────────────────────────────

    /**
     * Initialize: ensure data directory exists, load registries, load existing artifacts.
     * Called once at startup — does NOT trigger a full refresh.
     */
    public init(): void {
        this._ensureDataDir();
        this.invariantRegistry.load();
        this.capabilityRegistry.load();

        // Load existing generated artifacts if present
        this.lastIndex = this.builder.loadExistingIndex(this._indexPath());
        this.lastOwnershipMap = this.mapper.loadExistingMap(this._ownershipMapPath());
        this.lastMeta = this._loadMeta();

        // Build query service from existing artifacts
        this.queryService = new SelfModelQueryService(
            this.invariantRegistry,
            this.capabilityRegistry,
            this.lastIndex,
            this.lastOwnershipMap,
        );
    }

    // ─── Refresh ───────────────────────────────────────────────────────────────

    /**
     * Perform a full self-model refresh.
     * Emits telemetry. Writes artifacts to disk.
     * Returns the updated meta.
     */
    public async refresh(force = false): Promise<SelfModelMeta> {
        const startMs = Date.now();

        telemetry.operational(
            'self_model',
            'self_model_refresh_requested',
            'info',
            'SelfModelRefreshService',
            'Self-model refresh requested',
            'success',
            { payload: { force } },
        );

        // Staleness check (skip if forced)
        if (!force && this.lastMeta && this.lastMeta.status === 'fresh') {
            const ageMs = Date.now() - new Date(this.lastMeta.generatedAt).getTime();
            if (ageMs < FRESHNESS_WINDOW_MS) {
                // Still fresh — return existing meta
                return this.lastMeta;
            }
        }

        try {
            // Step 1: Build index
            const index = await this.builder.buildIndex();

            // Step 2: Build ownership map
            const ownershipMap = this.mapper.buildOwnershipMap(index);

            // Step 3: Compute hashes
            const indexHash = SelfModelBuilder.hashIndex(index);
            const ownershipHash = OwnershipMapper.hashOwnershipMap(ownershipMap);

            // Step 4: Drift detection
            const { driftedSubsystems, staleReasons } = this._detectDrift(indexHash, ownershipHash, index, ownershipMap);

            // Step 5: Determine status
            const status: SelfModelHealthStatus = driftedSubsystems.length > 0 ? 'drifted' : 'fresh';

            // Step 6: Write artifacts atomically
            this._writeAtomic(this._indexPath(), index);
            this._writeAtomic(this._ownershipMapPath(), ownershipMap);

            const meta: SelfModelMeta = {
                version: VERSION,
                generatedAt: new Date().toISOString(),
                commitSha: index.commitSha,
                indexHash,
                ownershipHash,
                status,
                staleReasons,
                driftedSubsystems,
                refreshDurationMs: Date.now() - startMs,
            };

            this._writeAtomic(this._metaPath(), meta);

            // Step 7: Update in-memory state
            this.lastIndex = index;
            this.lastOwnershipMap = ownershipMap;
            this.lastMeta = meta;

            if (!this.queryService) {
                this.queryService = new SelfModelQueryService(
                    this.invariantRegistry,
                    this.capabilityRegistry,
                    index,
                    ownershipMap,
                );
            } else {
                this.queryService.setIndex(index);
                this.queryService.setOwnershipMap(ownershipMap);
            }

            // Step 8: Telemetry
            telemetry.operational(
                'self_model',
                'self_model_refresh_completed',
                'info',
                'SelfModelRefreshService',
                `Self-model refresh completed in ${meta.refreshDurationMs}ms. Status: ${status}`,
                'success',
                { payload: { durationMs: meta.refreshDurationMs, totalArtifacts: index.totalArtifacts, status, driftedSubsystemCount: driftedSubsystems.length } },
            );

            if (driftedSubsystems.length > 0) {
                telemetry.operational(
                    'self_model',
                    'self_model_stale',
                    'warn',
                    'SelfModelRefreshService',
                    `Self-model drift detected in ${driftedSubsystems.length} subsystem(s): ${driftedSubsystems.slice(0, 5).join(', ')}${driftedSubsystems.length > 5 ? '…' : ''}`,
                    'partial',
                    { payload: { driftedSubsystemCount: driftedSubsystems.length, staleReasonCount: staleReasons.length } },
                );
            }

            return meta;

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[SelfModelRefreshService] Refresh failed:', msg);

            telemetry.operational(
                'self_model',
                'self_model_refresh_failed',
                'error',
                'SelfModelRefreshService',
                `Self-model refresh failed: ${msg}`,
                'failure',
            );

            // Return previous meta unchanged, or minimal error meta
            return this.lastMeta ?? this._errorMeta(msg, Date.now() - startMs);
        }
    }

    // ─── Staleness check ───────────────────────────────────────────────────────

    /**
     * Check whether the current self-model artifacts are stale.
     * Does not trigger a refresh.
     */
    public checkStaleness(): SelfModelHealthStatus {
        if (!this.lastMeta) return 'missing';

        if (this.lastMeta.status === 'error') return 'error';

        const ageMs = Date.now() - new Date(this.lastMeta.generatedAt).getTime();
        if (ageMs > FRESHNESS_WINDOW_MS) return 'stale';

        if (this.lastMeta.driftedSubsystems.length > 0) return 'drifted';

        return 'fresh';
    }

    // ─── Accessors ─────────────────────────────────────────────────────────────

    public getQueryService(): SelfModelQueryService | null {
        return this.queryService;
    }

    public getLastIndex(): SystemInventoryIndex | null {
        return this.lastIndex;
    }

    public getLastOwnershipMap(): OwnershipMap | null {
        return this.lastOwnershipMap;
    }

    public getLastMeta(): SelfModelMeta | null {
        return this.lastMeta;
    }

    public getInvariantRegistry(): InvariantRegistry {
        return this.invariantRegistry;
    }

    public getCapabilityRegistry(): CapabilityRegistry {
        return this.capabilityRegistry;
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _indexPath(): string {
        return path.join(this.dataDir, 'self_model_index.json');
    }

    private _ownershipMapPath(): string {
        return path.join(this.dataDir, 'subsystem_ownership_map.json');
    }

    private _metaPath(): string {
        return path.join(this.dataDir, 'self_model_meta.json');
    }

    private _ensureDataDir(): void {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
        } catch { /* ignore if already exists */ }
    }

    private _loadMeta(): SelfModelMeta | null {
        try {
            const raw = fs.readFileSync(this._metaPath(), 'utf-8');
            return JSON.parse(raw) as SelfModelMeta;
        } catch {
            return null;
        }
    }

    /** Write data to a .tmp file then rename for atomic-ish write behavior. */
    private _writeAtomic(targetPath: string, data: unknown): void {
        const tmpPath = targetPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
            fs.renameSync(tmpPath, targetPath);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // Clean up tmp file if rename failed
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw new Error(`Failed to write ${targetPath}: ${msg}`);
        }
    }

    private _detectDrift(
        newIndexHash: string,
        newOwnershipHash: string,
        newIndex: SystemInventoryIndex,
        newOwnershipMap: OwnershipMap,
    ): { driftedSubsystems: string[]; staleReasons: string[] } {
        const driftedSubsystems: string[] = [];
        const staleReasons: string[] = [];

        if (!this.lastMeta) {
            // First generation — nothing to compare against
            return { driftedSubsystems: [], staleReasons: [] };
        }

        if (newIndexHash !== this.lastMeta.indexHash) {
            staleReasons.push('index_hash_changed');

            // Find which subsystems have changed file counts
            if (this.lastOwnershipMap) {
                const prevSubsystemFileCounts = new Map<string, number>();
                for (const s of this.lastOwnershipMap.subsystems) {
                    const count = this.lastIndex?.artifacts.filter(a => a.subsystemId === s.id).length ?? 0;
                    prevSubsystemFileCounts.set(s.id, count);
                }
                for (const s of newOwnershipMap.subsystems) {
                    const newCount = newIndex.artifacts.filter(a => a.subsystemId === s.id).length;
                    const prevCount = prevSubsystemFileCounts.get(s.id) ?? 0;
                    if (newCount !== prevCount && !driftedSubsystems.includes(s.id)) {
                        driftedSubsystems.push(s.id);
                    }
                }
            }

            // Check for new or removed files
            const prevPaths = new Set(this.lastIndex?.artifacts.map(a => a.path) ?? []);
            const newPaths = new Set(newIndex.artifacts.map(a => a.path));
            const added = newIndex.artifacts.filter(a => !prevPaths.has(a.path)).length;
            const removed = (this.lastIndex?.artifacts ?? []).filter(a => !newPaths.has(a.path)).length;
            if (added > 0) staleReasons.push(`${added}_new_files`);
            if (removed > 0) staleReasons.push(`${removed}_removed_files`);
        }

        if (newOwnershipHash !== this.lastMeta.ownershipHash) {
            if (!staleReasons.includes('index_hash_changed')) {
                staleReasons.push('ownership_map_changed');
            }
        }

        return { driftedSubsystems, staleReasons };
    }

    private _errorMeta(errorMsg: string, durationMs: number): SelfModelMeta {
        return {
            version: VERSION,
            generatedAt: new Date().toISOString(),
            indexHash: '',
            ownershipHash: '',
            status: 'error',
            staleReasons: [`refresh_failed: ${errorMsg}`],
            driftedSubsystems: [],
            refreshDurationMs: durationMs,
        };
    }
}
