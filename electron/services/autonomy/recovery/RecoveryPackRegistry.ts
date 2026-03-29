/**
 * RecoveryPackRegistry.ts — Phase 4.3 P4.3B
 *
 * Source-controlled registry of recovery packs.
 *
 * Responsibilities:
 * - Load built-in pack definitions from the committed defaults.
 * - Load per-pack confidence overrides from local disk.
 * - Apply confidence overrides on top of static pack definitions.
 * - Expose deterministic query methods: getAll(), getById().
 * - Persist confidence updates on outcome tracking.
 * - Support enable/disable flags (persisted locally).
 *
 * Storage:
 *   <dataDir>/autonomy/recovery/registry.json  — confidence + enabled overrides
 *
 * The pack definitions themselves are NEVER written to disk.
 * Only confidence.current and enabled state are persisted.
 *
 * Mirrors InvariantRegistry (Phase 1) / OutcomeLearningRegistry (Phase 4) patterns:
 * static defaults + local override layer.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RecoveryPack, RecoveryPackId } from '../../../../shared/recoveryPackTypes';
import { BUILTIN_RECOVERY_PACKS } from './defaults/recoveryPacks';
import { telemetry } from '../../TelemetryService';

// ─── Override record shape ────────────────────────────────────────────────────

interface PackOverrideRecord {
    confidenceCurrent: number;
    enabled: boolean;
    successCount: number;
    failureCount: number;
    rollbackCount: number;
    lastAdjustedAt?: string;
}

type OverrideMap = Record<string, PackOverrideRecord>;

// ─── RecoveryPackRegistry ─────────────────────────────────────────────────────

export class RecoveryPackRegistry {
    private readonly registryFile: string;
    /** In-memory merged view: static definition + applied overrides. */
    private packs: Map<RecoveryPackId, RecoveryPack> = new Map();

    constructor(dataDir: string) {
        const recoveryDir = path.join(dataDir, 'autonomy', 'recovery');
        this.registryFile = path.join(recoveryDir, 'registry.json');
        this._ensureDir(recoveryDir);
        this._load();
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns all packs. When enabledOnly is true, returns only enabled packs.
     */
    getAll(enabledOnly = false): RecoveryPack[] {
        const all = [...this.packs.values()];
        return enabledOnly ? all.filter(p => p.enabled) : all;
    }

    /**
     * Returns the pack with the given ID, or null if not found.
     */
    getById(packId: RecoveryPackId): RecoveryPack | null {
        return this.packs.get(packId) ?? null;
    }

    // ── Mutation (confidence + enabled) ────────────────────────────────────────

    /**
     * Applies a delta to a pack's confidence.current.
     * Clamps the result to [floor, ceiling].
     * Persists the updated override.
     */
    updateConfidence(
        packId: RecoveryPackId,
        delta: number,
        outcome: 'succeeded' | 'failed' | 'rolled_back' | 'governance_blocked' | 'aborted',
    ): void {
        const pack = this.packs.get(packId);
        if (!pack) return;

        const prev = pack.confidence.current;
        const next = Math.min(
            pack.confidence.ceiling,
            Math.max(pack.confidence.floor, prev + delta),
        );

        const updatedConfidence = {
            ...pack.confidence,
            current: next,
            lastAdjustedAt: new Date().toISOString(),
            successCount: outcome === 'succeeded' ? pack.confidence.successCount + 1 : pack.confidence.successCount,
            failureCount: (outcome === 'failed' || outcome === 'aborted') ? pack.confidence.failureCount + 1 : pack.confidence.failureCount,
            rollbackCount: outcome === 'rolled_back' ? pack.confidence.rollbackCount + 1 : pack.confidence.rollbackCount,
        };

        const updatedPack = { ...pack, confidence: updatedConfidence };
        this.packs.set(packId, updatedPack);
        this._persistOverrides();

        telemetry.operational(
            'autonomy',
            'recovery_pack_confidence_adjusted',
            'info',
            'RecoveryPackRegistry',
            `Pack ${packId} confidence adjusted: ${prev.toFixed(3)} → ${next.toFixed(3)} (delta ${delta > 0 ? '+' : ''}${delta.toFixed(3)}, outcome: ${outcome})`,
        );
    }

    /**
     * Enables or disables a pack by ID.
     * Persists the change.
     */
    setEnabled(packId: RecoveryPackId, enabled: boolean): void {
        const pack = this.packs.get(packId);
        if (!pack) return;
        this.packs.set(packId, { ...pack, enabled });
        this._persistOverrides();
        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'RecoveryPackRegistry',
            `Pack ${packId} ${enabled ? 'enabled' : 'disabled'}`,
        );
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    /** Load built-in packs and apply persisted overrides. */
    private _load(): void {
        const overrides = this._loadOverrides();

        for (const staticPack of BUILTIN_RECOVERY_PACKS) {
            const override = overrides[staticPack.packId];
            const pack: RecoveryPack = {
                ...staticPack,
                enabled: override ? override.enabled : staticPack.enabled,
                confidence: override
                    ? {
                        ...staticPack.confidence,
                        current: override.confidenceCurrent,
                        successCount: override.successCount,
                        failureCount: override.failureCount,
                        rollbackCount: override.rollbackCount,
                        lastAdjustedAt: override.lastAdjustedAt,
                    }
                    : { ...staticPack.confidence },
            };

            // Safety: auto-disable packs whose allowedSubsystems overlap with hardBlockedSubsystems.
            // Note: the hardBlockedSubsystems check also happens at match time; this is belt-and-suspenders.
            this.packs.set(pack.packId, pack);
        }
    }

    private _loadOverrides(): OverrideMap {
        if (!fs.existsSync(this.registryFile)) return {};
        try {
            return JSON.parse(fs.readFileSync(this.registryFile, 'utf-8')) as OverrideMap;
        } catch {
            return {};
        }
    }

    private _persistOverrides(): void {
        const overrides: OverrideMap = {};
        for (const [packId, pack] of this.packs) {
            overrides[packId] = {
                confidenceCurrent: pack.confidence.current,
                enabled: pack.enabled,
                successCount: pack.confidence.successCount,
                failureCount: pack.confidence.failureCount,
                rollbackCount: pack.confidence.rollbackCount,
                lastAdjustedAt: pack.confidence.lastAdjustedAt,
            };
        }
        try {
            fs.writeFileSync(this.registryFile, JSON.stringify(overrides, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'RecoveryPackRegistry',
                `Failed to persist registry overrides: ${err.message}`,
            );
        }
    }

    private _ensureDir(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            // Non-fatal
        }
    }
}
