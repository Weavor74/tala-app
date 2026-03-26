/**
 * OwnershipMapper — Phase 1C
 *
 * Builds the SubsystemOwnershipMap from:
 * 1. The seed subsystem definitions in subsystem_mapping.json (hand-authored).
 * 2. The live SystemInventoryIndex produced by SelfModelBuilder.
 *
 * For each subsystem, derives:
 * - The set of owned files (by subsystem id from the index)
 * - Authority files (entrypoints, *Service.ts, *Router.ts by convention)
 * - Direct dependencies (from subsystem_mapping.json cross_boundary annotations)
 * - Blast radius / dependents (inverse of dependencies)
 * - Risk level (based on number of authority files and whether any are protected)
 * - Confidence (high if seed exists, medium if derived only)
 *
 * Design: ownership means authority, not mere participation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type {
    OwnershipMap,
    SubsystemRecord,
    OwnershipRecord,
    DependencyEdge,
    SystemInventoryIndex,
    RiskLevel,
    ConfidenceLevel,
} from '../../../shared/selfModelTypes';

// ─── Seed types (from subsystem_mapping.json) ─────────────────────────────────

interface SubsystemSeedEntry {
    id: string;
    name: string;
    root?: string;
    owns?: string[];
    test_paths?: string[];
    cross_boundary?: string[];
    do_not_place_here?: string[];
}

interface SubsystemMappingSeed {
    version: string;
    description: string;
    subsystems: SubsystemSeedEntry[];
}

// ─── Known logical subsystems not in subsystem_mapping.json ──────────────────

/** Logical subsystems derived from the electron/services subdirectory structure. */
const LOGICAL_SUBSYSTEMS: SubsystemRecord[] = [
    {
        id: 'inference',
        name: 'Inference Orchestration',
        description: 'Local and cloud inference provider selection, streaming, timeouts, fallback, and brain adapters.',
        rootPaths: ['electron/services/inference/', 'electron/services/cognitive/', 'electron/services/plan/', 'electron/brains/'],
        authorityFiles: ['electron/services/InferenceService.ts', 'electron/services/cognitive/PreInferenceContextOrchestrator.ts'],
        entrypoints: ['electron/services/InferenceService.ts'],
        dependencies: ['electron-main', 'mcp'],
        dependents: ['electron-main'],
        invariantIds: ['inv-007', 'inv-008', 'inv-009'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'high',
        confidence: 'high',
    },
    {
        id: 'memory',
        name: 'Memory & Retrieval',
        description: 'Canonical memory, mem0, embedding, graph memory, retrieval, and authority conflict resolution.',
        rootPaths: ['electron/services/memory/', 'electron/services/embedding/', 'electron/services/graph/', 'electron/services/db/', 'electron/services/policy/', 'electron/migrations/'],
        authorityFiles: ['electron/services/MemoryService.ts', 'electron/services/HybridMemoryManager.ts'],
        entrypoints: ['electron/services/MemoryService.ts'],
        dependencies: ['electron-main'],
        dependents: ['electron-main', 'context-assembly'],
        invariantIds: ['inv-005', 'inv-006', 'inv-009'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'critical',
        confidence: 'high',
    },
    {
        id: 'retrieval',
        name: 'Retrieval Pipeline',
        description: 'RAG pipeline, providers, ingestion, search, external API search, and provider normalization.',
        rootPaths: ['electron/services/retrieval/', 'electron/services/ingestion/', 'electron/services/search/'],
        authorityFiles: ['electron/services/RagService.ts', 'electron/services/IngestionService.ts'],
        entrypoints: ['electron/services/RagService.ts'],
        dependencies: ['electron-main', 'memory'],
        dependents: ['electron-main', 'context-assembly'],
        invariantIds: ['inv-003', 'inv-004', 'inv-006'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'high',
        confidence: 'high',
    },
    {
        id: 'context-assembly',
        name: 'Context Assembly',
        description: 'Context scoring, ranking, cross-layer competition, authority conflict resolution, and deterministic assembly.',
        rootPaths: ['electron/services/context/', 'electron/services/router/'],
        authorityFiles: ['electron/services/context/ContextAssemblyService.ts', 'electron/services/router/TalaContextRouter.ts'],
        entrypoints: ['electron/services/context/ContextAssemblyService.ts'],
        dependencies: ['memory', 'retrieval', 'inference'],
        dependents: ['electron-main'],
        invariantIds: ['inv-004', 'inv-005'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'high',
        confidence: 'high',
    },
    {
        id: 'mcp',
        name: 'MCP Lifecycle',
        description: 'MCP server spawning, lifecycle management, protocol communication, and capability gating.',
        rootPaths: ['electron/services/McpService.ts', 'electron/services/McpLifecycleManager.ts'],
        authorityFiles: ['electron/services/McpService.ts', 'electron/services/McpLifecycleManager.ts'],
        entrypoints: ['electron/services/McpService.ts'],
        dependencies: ['electron-main'],
        dependents: ['electron-main', 'inference', 'memory'],
        invariantIds: ['inv-008', 'inv-009'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'high',
        confidence: 'high',
    },
    {
        id: 'reflection',
        name: 'Reflection & Self-Improvement',
        description: 'Autonomous self-improvement pipeline: observe, reflect, patch, validate, promote. Manages goals, issues, patches, validation, promotion, and rollback.',
        rootPaths: ['electron/services/reflection/'],
        authorityFiles: ['electron/services/reflection/ReflectionService.ts', 'electron/services/reflection/ReflectionAppService.ts'],
        entrypoints: ['electron/services/reflection/ReflectionService.ts'],
        dependencies: ['electron-main', 'mcp'],
        dependents: ['electron-main'],
        invariantIds: ['inv-001', 'inv-007'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'critical',
        confidence: 'high',
    },
    {
        id: 'soul',
        name: 'Soul & Identity',
        description: 'Identity evolution, ethics engine, narrative reasoning, hypothesis management, and soul logging.',
        rootPaths: ['electron/services/soul/'],
        authorityFiles: ['electron/services/soul/SoulService.ts'],
        entrypoints: ['electron/services/soul/SoulService.ts'],
        dependencies: ['electron-main'],
        dependents: ['electron-main'],
        invariantIds: ['inv-001'],
        testFiles: [],
        docFiles: [],
        riskLevel: 'critical',
        confidence: 'high',
    },
    {
        id: 'maintenance',
        name: 'Self-Maintenance',
        description: 'Issue detection, policy evaluation, safe action execution, and maintenance loop coordination.',
        rootPaths: ['electron/services/maintenance/'],
        authorityFiles: ['electron/services/maintenance/MaintenanceLoopService.ts'],
        entrypoints: ['electron/services/maintenance/MaintenanceLoopService.ts'],
        dependencies: ['electron-main'],
        dependents: ['electron-main'],
        invariantIds: ['inv-009'],
        testFiles: ['tests/SelfMaintenance.test.ts'],
        docFiles: [],
        riskLevel: 'medium',
        confidence: 'high',
    },
    {
        id: 'world-model',
        name: 'World Model',
        description: 'World model assembly, context summarization, and cognitive turn diagnostics.',
        rootPaths: ['electron/services/world/'],
        authorityFiles: ['electron/services/world/WorldModelAssembler.ts'],
        entrypoints: ['electron/services/world/WorldModelAssembler.ts'],
        dependencies: ['electron-main', 'memory'],
        dependents: ['electron-main'],
        invariantIds: [],
        testFiles: [],
        docFiles: [],
        riskLevel: 'medium',
        confidence: 'high',
    },
    {
        id: 'self-model',
        name: 'Self-Model Foundation',
        description: 'System inventory index, subsystem ownership, invariant registry, capability registry, query service, and refresh/drift detection.',
        rootPaths: ['electron/services/selfModel/'],
        authorityFiles: ['electron/services/selfModel/SelfModelRefreshService.ts', 'electron/services/selfModel/SelfModelQueryService.ts'],
        entrypoints: ['electron/services/selfModel/SelfModelAppService.ts'],
        dependencies: ['electron-main'],
        dependents: ['electron-main'],
        invariantIds: ['inv-001'],
        testFiles: ['tests/SelfModelPhase1.test.ts'],
        docFiles: [],
        riskLevel: 'medium',
        confidence: 'high',
    },
];

// ─── Cross-boundary → dependency edge mapping ─────────────────────────────────

/** Parse cross_boundary annotations and emit DependencyEdge entries. */
function parseCrossBoundary(subsystemId: string, crossBoundary: string[]): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const annotation of crossBoundary) {
        const lower = annotation.toLowerCase();
        if (lower.includes('ipc')) {
            edges.push({ from: subsystemId, to: 'renderer', kind: 'ipc', notes: annotation });
        }
        if (lower.includes('mcp')) {
            edges.push({ from: subsystemId, to: 'mcp', kind: 'mcp_protocol', notes: annotation });
        }
        if (lower.includes('http') || lower.includes('inference')) {
            edges.push({ from: subsystemId, to: 'local-inference', kind: 'http', notes: annotation });
        }
    }
    return edges;
}

// ─── Risk level derivation ────────────────────────────────────────────────────

function deriveRiskLevel(subsystem: SubsystemRecord, hasProtectedFiles: boolean): RiskLevel {
    if (subsystem.invariantIds.some(id => ['inv-001', 'inv-005'].includes(id))) return 'critical';
    if (hasProtectedFiles || subsystem.dependencies.length > 3) return 'high';
    if (subsystem.dependencies.length > 1) return 'medium';
    return 'low';
}

// ─── OwnershipMapper ──────────────────────────────────────────────────────────

export class OwnershipMapper {
    private readonly repoRoot: string;

    constructor(repoRoot: string) {
        this.repoRoot = repoRoot;
    }

    /**
     * Build the complete OwnershipMap from the inventory index.
     * This is the P1C deliverable.
     */
    public buildOwnershipMap(index: SystemInventoryIndex): OwnershipMap {
        const seed = this._loadSeed();

        // Start with our logical subsystem definitions, then enrich from seed
        const subsystems = this._buildSubsystems(index, seed);

        // Build per-file ownership records (authority files only for brevity)
        const ownership = this._buildOwnershipRecords(index, subsystems);

        // Build dependency edges
        const edges = this._buildDependencyEdges(subsystems, seed);

        // Derive dependents (inverse of dependencies)
        this._deriveDependents(subsystems);

        // Enrich with test/doc files from index
        this._enrichWithTestsAndDocs(subsystems, index);

        return {
            version: '1.0',
            generatedAt: new Date().toISOString(),
            subsystems,
            ownership,
            dependencyEdges: edges,
        };
    }

    /**
     * Compute a hash of the ownership map for drift detection.
     */
    public static hashOwnershipMap(map: OwnershipMap): string {
        const stable = map.subsystems
            .map(s => `${s.id}|${s.authorityFiles.sort().join(',')}|${s.dependencies.sort().join(',')}`)
            .join('\n');
        return createHash('sha256').update(stable).digest('hex');
    }

    /**
     * Load an existing map from disk. Returns null if not found.
     */
    public loadExistingMap(mapPath: string): OwnershipMap | null {
        try {
            const raw = fs.readFileSync(mapPath, 'utf-8');
            return JSON.parse(raw) as OwnershipMap;
        } catch {
            return null;
        }
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _loadSeed(): SubsystemMappingSeed | null {
        const seedPath = path.join(this.repoRoot, 'subsystem_mapping.json');
        try {
            const raw = fs.readFileSync(seedPath, 'utf-8');
            return JSON.parse(raw) as SubsystemMappingSeed;
        } catch {
            return null;
        }
    }

    private _buildSubsystems(index: SystemInventoryIndex, seed: SubsystemMappingSeed | null): SubsystemRecord[] {
        // Use our logical subsystem definitions as the canonical foundation
        const subsystemMap = new Map<string, SubsystemRecord>();

        // Clone logical subsystems
        for (const s of LOGICAL_SUBSYSTEMS) {
            subsystemMap.set(s.id, { ...s, testFiles: [...s.testFiles], docFiles: [...s.docFiles], dependencies: [...s.dependencies], dependents: [...s.dependents], invariantIds: [...s.invariantIds], authorityFiles: [...s.authorityFiles], entrypoints: [...s.entrypoints], rootPaths: [...s.rootPaths] });
        }

        // Merge seed subsystems that aren't already present
        if (seed) {
            for (const entry of seed.subsystems) {
                if (!subsystemMap.has(entry.id)) {
                    subsystemMap.set(entry.id, {
                        id: entry.id,
                        name: entry.name,
                        description: `${entry.name} subsystem`,
                        rootPaths: entry.root ? [entry.root] : [],
                        authorityFiles: [],
                        entrypoints: [],
                        dependencies: [],
                        dependents: [],
                        invariantIds: [],
                        testFiles: entry.test_paths ?? [],
                        docFiles: [],
                        riskLevel: 'medium',
                        confidence: 'medium',
                    });
                }
            }
        }

        // Enrich with files from index
        const subsystems = Array.from(subsystemMap.values());

        for (const s of subsystems) {
            const ownedFiles = index.artifacts.filter(a => a.subsystemId === s.id);
            const entrypointFiles = ownedFiles.filter(a => a.isEntrypoint).map(a => a.path);
            const authorityFiles = ownedFiles.filter(a => this._isAuthorityFile(a.path)).map(a => a.path);

            // Merge discovered entrypoints into the subsystem record
            for (const ep of entrypointFiles) {
                if (!s.entrypoints.includes(ep)) s.entrypoints.push(ep);
            }
            for (const af of authorityFiles) {
                if (!s.authorityFiles.includes(af)) s.authorityFiles.push(af);
            }

            const hasProtectedFiles = ownedFiles.some(a => a.isProtected);
            s.riskLevel = deriveRiskLevel(s, hasProtectedFiles);
        }

        // Add 'unknown' subsystem for unclassified files
        subsystemMap.set('unknown', {
            id: 'unknown',
            name: 'Unknown / Unclassified',
            description: 'Files that could not be classified into a known subsystem.',
            rootPaths: [],
            authorityFiles: [],
            entrypoints: [],
            dependencies: [],
            dependents: [],
            invariantIds: [],
            testFiles: [],
            docFiles: [],
            riskLevel: 'low',
            confidence: 'low',
        });

        return Array.from(subsystemMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    }

    private _isAuthorityFile(rel: string): boolean {
        const base = path.basename(rel);
        if (base === 'main.ts' || base === 'main.py' || base === 'preload.ts') return true;
        if (/Service\.ts$/.test(base) || /Router\.ts$/.test(base)) return true;
        if (/Manager\.ts$/.test(base) || /Orchestrator\.ts$/.test(base)) return true;
        return false;
    }

    private _buildOwnershipRecords(index: SystemInventoryIndex, subsystems: SubsystemRecord[]): OwnershipRecord[] {
        const authoritySet = new Set<string>(subsystems.flatMap(s => s.authorityFiles));
        const records: OwnershipRecord[] = [];

        for (const artifact of index.artifacts) {
            if (!authoritySet.has(artifact.path) && !artifact.isEntrypoint) continue;

            const confidence: ConfidenceLevel = artifact.subsystemId === 'unknown' ? 'low' : 'high';
            records.push({
                path: artifact.path,
                subsystemId: artifact.subsystemId,
                isAuthority: authoritySet.has(artifact.path) || artifact.isEntrypoint,
                confidence,
                reason: artifact.isEntrypoint ? 'explicit entrypoint' : 'service file naming convention',
            });
        }

        return records;
    }

    private _buildDependencyEdges(subsystems: SubsystemRecord[], seed: SubsystemMappingSeed | null): DependencyEdge[] {
        const edges: DependencyEdge[] = [];
        const seen = new Set<string>();

        // From logical subsystem definitions
        for (const s of subsystems) {
            for (const dep of s.dependencies) {
                const key = `${s.id}->${dep}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    edges.push({ from: s.id, to: dep, kind: 'import' });
                }
            }
        }

        // From seed cross_boundary annotations
        if (seed) {
            for (const entry of seed.subsystems) {
                for (const edge of parseCrossBoundary(entry.id, entry.cross_boundary ?? [])) {
                    const key = `${edge.from}->${edge.to}:${edge.kind}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        edges.push(edge);
                    }
                }
            }
        }

        return edges;
    }

    private _deriveDependents(subsystems: SubsystemRecord[]): void {
        const subsystemMap = new Map<string, SubsystemRecord>(subsystems.map(s => [s.id, s]));

        for (const s of subsystems) {
            for (const dep of s.dependencies) {
                const target = subsystemMap.get(dep);
                if (target && !target.dependents.includes(s.id)) {
                    target.dependents.push(s.id);
                }
            }
        }
    }

    private _enrichWithTestsAndDocs(subsystems: SubsystemRecord[], index: SystemInventoryIndex): void {
        const testArtifacts = index.artifacts.filter(a => a.kind === 'test');
        const docArtifacts = index.artifacts.filter(a => a.kind === 'doc');

        for (const s of subsystems) {
            // Associate test files by name conventions (e.g. tests/ files that mention subsystem terms)
            for (const test of testArtifacts) {
                const base = path.basename(test.path, '.test.ts');
                const isRelevant = s.rootPaths.some(rp => {
                    const dir = rp.split('/').filter(Boolean).pop() ?? '';
                    return base.toLowerCase().includes(dir.toLowerCase()) || base.toLowerCase().includes(s.id.toLowerCase().replace('-', ''));
                }) || s.authorityFiles.some(af => {
                    const afBase = path.basename(af, '.ts');
                    return base.includes(afBase);
                });
                if (isRelevant && !s.testFiles.includes(test.path)) {
                    s.testFiles.push(test.path);
                }
            }

            // Associate doc files
            for (const doc of docArtifacts) {
                const docBase = path.basename(doc.path).toLowerCase();
                const isRelevant = s.rootPaths.some(rp => {
                    const dir = rp.split('/').filter(Boolean).pop() ?? '';
                    return docBase.includes(dir.toLowerCase());
                });
                if (isRelevant && !s.docFiles.includes(doc.path)) {
                    s.docFiles.push(doc.path);
                }
            }
        }
    }
}
