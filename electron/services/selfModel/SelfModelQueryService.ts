/**
 * SelfModelQueryService — Phase 1F
 *
 * Stateless query service that answers self-inspection questions against
 * the loaded self-model artifacts (index, ownership map, invariant registry,
 * capability registry).
 *
 * Answers:
 * - What file owns this behavior?
 * - What tests cover it?
 * - What invariants apply?
 * - What other systems could be affected?
 * - How confident is the answer?
 *
 * Design rules:
 * - No file I/O at query time — operates only on in-memory data.
 * - Returns confidence: high (1 match), medium (2), low (3+), unknown (no index).
 * - Never throws — returns structured error/unknown results on failure.
 */

import * as path from 'path';
import type {
    SystemInventoryIndex,
    OwnershipMap,
    SubsystemRecord,
    OwnershipRecord,
    InvariantRecord,
    CapabilityRecord,
    OwnershipQueryResult,
    BlastRadiusResult,
    ConfidenceLevel,
    RiskLevel,
} from '../../../shared/selfModelTypes';
import type { InvariantRegistry } from './InvariantRegistry';
import type { CapabilityRegistry } from './CapabilityRegistry';

// ─── SelfModelQueryService ────────────────────────────────────────────────────

export class SelfModelQueryService {
    constructor(
        private readonly invariantRegistry: InvariantRegistry,
        private readonly capabilityRegistry: CapabilityRegistry,
        private index: SystemInventoryIndex | null = null,
        private ownershipMap: OwnershipMap | null = null,
    ) {}

    /** Update the index after a refresh. */
    public setIndex(index: SystemInventoryIndex): void {
        this.index = index;
    }

    /** Update the ownership map after a refresh. */
    public setOwnershipMap(map: OwnershipMap): void {
        this.ownershipMap = map;
    }

    // ─── Ownership queries ─────────────────────────────────────────────────────

    /**
     * Find the owning subsystem for a file path or search term.
     *
     * Strategy:
     * 1. Exact path match against index artifacts.
     * 2. Substring/basename match against index artifacts.
     * 3. Path-prefix match against subsystem rootPaths.
     */
    public findOwningSubsystem(queryOrTarget: string): OwnershipQueryResult {
        if (!this.index || !this.ownershipMap) {
            return this._unknownOwnership(queryOrTarget, 'Self-model index not loaded. Run selfModel:refresh first.');
        }

        const target = queryOrTarget.replace(/\\/g, '/');
        const matchedArtifacts = this._findArtifacts(target);

        if (matchedArtifacts.length === 0) {
            // Try subsystem id direct lookup
            const subsystem = this.ownershipMap.subsystems.find(
                s => s.id === target || s.name.toLowerCase().includes(target.toLowerCase())
            );
            if (subsystem) {
                return {
                    target,
                    owningSubsystem: subsystem,
                    owningFiles: this.ownershipMap.ownership.filter(o => o.subsystemId === subsystem.id),
                    relatedTests: subsystem.testFiles,
                    relatedInvariants: this.invariantRegistry.getBySubsystem(subsystem.id),
                    confidence: 'high',
                    reasoning: `Direct subsystem id or name match: '${subsystem.id}'`,
                };
            }
            return this._unknownOwnership(queryOrTarget, `No files or subsystems matched '${queryOrTarget}'`);
        }

        // Get unique subsystem ids from matched artifacts
        const subsystemIds = [...new Set(matchedArtifacts.map(a => a.subsystemId))];
        const confidence = this._confidenceFromCount(subsystemIds.length);

        const primarySubsystemId = subsystemIds[0];
        const primarySubsystem = this.ownershipMap.subsystems.find(s => s.id === primarySubsystemId);

        const ownershipRecords: OwnershipRecord[] = matchedArtifacts
            .map(a => ({
                path: a.path,
                subsystemId: a.subsystemId,
                isAuthority: a.isEntrypoint || this._isAuthorityByName(a.path),
                confidence: a.subsystemId === 'unknown' ? 'low' as ConfidenceLevel : 'high' as ConfidenceLevel,
                reason: `classified as ${a.kind}`,
            }));

        const relatedTests = [
            ...(primarySubsystem?.testFiles ?? []),
            ...matchedArtifacts.flatMap(a => a.associatedTests ?? []),
        ].filter((v, i, arr) => arr.indexOf(v) === i);

        const relatedInvariants = primarySubsystem
            ? this.invariantRegistry.getBySubsystem(primarySubsystem.id)
            : [];

        return {
            target,
            owningSubsystem: primarySubsystem,
            owningFiles: ownershipRecords,
            relatedTests,
            relatedInvariants,
            confidence,
            reasoning: subsystemIds.length === 1
                ? `Unambiguous match: all ${matchedArtifacts.length} file(s) belong to '${primarySubsystemId}'`
                : `Ambiguous: files span ${subsystemIds.length} subsystems: ${subsystemIds.join(', ')}`,
        };
    }

    /**
     * Find all files that match a query.
     */
    public findOwningFiles(queryOrTarget: string): OwnershipRecord[] {
        if (!this.index || !this.ownershipMap) return [];
        const target = queryOrTarget.replace(/\\/g, '/');
        return this._findArtifacts(target).map(a => ({
            path: a.path,
            subsystemId: a.subsystemId,
            isAuthority: a.isEntrypoint || this._isAuthorityByName(a.path),
            confidence: a.subsystemId === 'unknown' ? 'low' as ConfidenceLevel : 'high' as ConfidenceLevel,
            reason: `classified as ${a.kind}`,
        }));
    }

    // ─── Test queries ─────────────────────────────────────────────────────────

    /**
     * Get all test files associated with a subsystem id.
     */
    public getTestsForSubsystem(subsystemId: string): string[] {
        if (!this.ownershipMap) return [];
        const subsystem = this.ownershipMap.subsystems.find(s => s.id === subsystemId);
        return subsystem?.testFiles ?? [];
    }

    // ─── Invariant queries ────────────────────────────────────────────────────

    /**
     * Get all invariants that apply to a subsystem.
     */
    public getInvariantsForSubsystem(subsystemId: string): InvariantRecord[] {
        return this.invariantRegistry.getBySubsystem(subsystemId);
    }

    // ─── Blast radius ─────────────────────────────────────────────────────────

    /**
     * Get subsystem ids that depend on the given subsystem.
     */
    public getAffectedSystems(subsystemId: string): string[] {
        if (!this.ownershipMap) return [];
        const subsystem = this.ownershipMap.subsystems.find(s => s.id === subsystemId);
        return subsystem?.dependents ?? [];
    }

    /**
     * Explain the full blast radius for a subsystem or file path.
     */
    public explainBlastRadius(target: string): BlastRadiusResult {
        if (!this.ownershipMap) {
            return {
                subsystemId: target,
                subsystemName: target,
                directDependents: [],
                transitivelyAffected: [],
                riskLevel: 'unknown' as unknown as RiskLevel,
                reasoning: 'Self-model ownership map not loaded. Run selfModel:refresh first.',
            };
        }

        // Resolve target to subsystem id
        let subsystem = this.ownershipMap.subsystems.find(s => s.id === target);
        if (!subsystem) {
            // Try by file path
            const artifact = this.index?.artifacts.find(a => a.path === target || a.path.includes(target));
            if (artifact) {
                subsystem = this.ownershipMap.subsystems.find(s => s.id === artifact.subsystemId);
            }
        }
        if (!subsystem) {
            return {
                subsystemId: target,
                subsystemName: target,
                directDependents: [],
                transitivelyAffected: [],
                riskLevel: 'low',
                reasoning: `No subsystem found for target '${target}'`,
            };
        }

        const directDependents = subsystem.dependents;
        const transitive = this._getTransitiveDependents(subsystem.id, new Set());

        return {
            subsystemId: subsystem.id,
            subsystemName: subsystem.name,
            directDependents,
            transitivelyAffected: transitive.filter(id => !directDependents.includes(id)),
            riskLevel: subsystem.riskLevel,
            reasoning: `${subsystem.name} has ${directDependents.length} direct dependents and ${transitive.length} total affected subsystems`,
        };
    }

    // ─── Capability queries ───────────────────────────────────────────────────

    /**
     * Get all available capabilities.
     */
    public getCapabilities(): CapabilityRecord[] {
        return this.capabilityRegistry.getAll();
    }

    /**
     * Get capabilities available in a given mode.
     */
    public getCapabilitiesForMode(mode: string): CapabilityRecord[] {
        return this.capabilityRegistry.getByMode(mode);
    }

    // ─── Explain ownership (narrative) ────────────────────────────────────────

    /**
     * Return a human-readable explanation of who owns a file/behavior.
     */
    public explainOwnership(target: string): string {
        const result = this.findOwningSubsystem(target);

        if (!result.owningSubsystem) {
            return `No ownership information found for '${target}'. Confidence: ${result.confidence}. ${result.reasoning}`;
        }

        const s = result.owningSubsystem;
        const invariantCount = result.relatedInvariants.length;
        const testCount = result.relatedTests.length;

        return [
            `'${target}' is owned by subsystem '${s.name}' (id: ${s.id}).`,
            `Risk level: ${s.riskLevel}. Confidence: ${result.confidence}.`,
            invariantCount > 0 ? `${invariantCount} invariant(s) apply: ${result.relatedInvariants.map(i => i.id).join(', ')}.` : 'No invariants tracked for this subsystem.',
            testCount > 0 ? `${testCount} test file(s) cover this subsystem.` : 'No test files found for this subsystem.',
            result.reasoning,
        ].join('\n');
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _findArtifacts(target: string) {
        if (!this.index) return [];
        const lower = target.toLowerCase();
        const basename = path.basename(target, path.extname(target)).toLowerCase();

        return this.index.artifacts.filter(a => {
            const aLower = a.path.toLowerCase();
            // Exact match
            if (aLower === lower) return true;
            // Basename match
            if (path.basename(a.path, path.extname(a.path)).toLowerCase() === basename && basename.length > 3) return true;
            // Substring match on the path (but only if target is long enough to be specific)
            if (lower.length > 4 && aLower.includes(lower)) return true;
            // Tag match
            if (a.tags.some(t => t.toLowerCase() === lower)) return true;
            return false;
        });
    }

    private _confidenceFromCount(count: number): ConfidenceLevel {
        if (count === 0) return 'unknown';
        if (count === 1) return 'high';
        if (count === 2) return 'medium';
        return 'low';
    }

    private _isAuthorityByName(rel: string): boolean {
        const base = path.basename(rel);
        return /Service\.ts$/.test(base) || /Router\.ts$/.test(base) || /Manager\.ts$/.test(base) || base === 'main.ts' || base === 'preload.ts';
    }

    private _getTransitiveDependents(subsystemId: string, visited: Set<string>): string[] {
        if (visited.has(subsystemId) || !this.ownershipMap) return [];
        visited.add(subsystemId);

        const subsystem = this.ownershipMap.subsystems.find(s => s.id === subsystemId);
        if (!subsystem) return [];

        const result: string[] = [...subsystem.dependents];
        for (const dep of subsystem.dependents) {
            for (const transitive of this._getTransitiveDependents(dep, visited)) {
                if (!result.includes(transitive)) result.push(transitive);
            }
        }
        return result;
    }

    private _unknownOwnership(target: string, reasoning: string): OwnershipQueryResult {
        return {
            target,
            owningSubsystem: undefined,
            owningFiles: [],
            relatedTests: [],
            relatedInvariants: [],
            confidence: 'unknown',
            reasoning,
        };
    }
}
