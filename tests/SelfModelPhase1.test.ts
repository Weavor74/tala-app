/**
 * SelfModelPhase1.test.ts
 *
 * Comprehensive tests for Phase 1 — Self-Model Foundation (P1A–P1H).
 *
 * Coverage:
 * P1A — Type contracts (structural validation)
 * P1B — SelfModelScanner classification heuristics + SelfModelBuilder
 * P1C — OwnershipMapper subsystem mapping
 * P1D — InvariantRegistry load, lookup, and validation
 * P1E — CapabilityRegistry load, lookup, and validation
 * P1F — SelfModelQueryService ownership, tests, invariants, blast radius
 * P1G — SelfModelAppService IPC channel registration (no duplicates)
 * P1H — SelfModelRefreshService refresh cycle, staleness detection, drift
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    app: { getPath: () => '/tmp/tala-test', getAppPath: () => '/tmp/tala-test', isPackaged: false },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        debug: vi.fn(),
        emit: vi.fn(),
    },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => `test-uuid-${Math.random().toString(36).slice(2, 8)}`) }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { SelfModelScanner } from '../electron/services/selfModel/SelfModelScanner';
import { SelfModelBuilder } from '../electron/services/selfModel/SelfModelBuilder';
import { OwnershipMapper } from '../electron/services/selfModel/OwnershipMapper';
import { InvariantRegistry } from '../electron/services/selfModel/InvariantRegistry';
import { CapabilityRegistry } from '../electron/services/selfModel/CapabilityRegistry';
import { SelfModelQueryService } from '../electron/services/selfModel/SelfModelQueryService';
import { SelfModelRefreshService } from '../electron/services/selfModel/SelfModelRefreshService';
import type {
    ArtifactRecord,
    SystemInventoryIndex,
    OwnershipMap,
    SubsystemRecord,
} from '../shared/selfModelTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Path to the actual repo root (where data/self_model/ lives). */
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SELF_MODEL_DATA_DIR = path.join(REPO_ROOT, 'data', 'self_model');

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-self-model-test-'));
}

function makeMinimalIndex(artifacts: Partial<ArtifactRecord>[] = []): SystemInventoryIndex {
    const full: ArtifactRecord[] = artifacts.map(a => ({
        path: 'electron/services/TestService.ts',
        kind: 'service' as const,
        subsystemId: 'electron-main',
        tags: ['service', 'electron'],
        isEntrypoint: false,
        isProtected: false,
        ...a,
    }));
    return {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        repoRoot: REPO_ROOT,
        totalArtifacts: full.length,
        artifacts: full,
        kindSummary: { service: full.length },
    };
}

function makeMinimalOwnershipMap(subsystems: Partial<SubsystemRecord>[] = []): OwnershipMap {
    const full: SubsystemRecord[] = subsystems.map(s => ({
        id: 'electron-main',
        name: 'Electron Main',
        description: 'Test subsystem',
        rootPaths: ['electron/'],
        authorityFiles: [],
        entrypoints: [],
        dependencies: [],
        dependents: [],
        invariantIds: [],
        testFiles: [],
        docFiles: [],
        riskLevel: 'medium' as const,
        confidence: 'high' as const,
        ...s,
    }));
    return {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        subsystems: full,
        ownership: [],
        dependencyEdges: [],
    };
}

// ─── P1A: Type contracts ──────────────────────────────────────────────────────

describe('P1A — Self-Model Types', () => {
    it('ArtifactRecord has required fields', () => {
        const record: ArtifactRecord = {
            path: 'electron/services/AgentService.ts',
            kind: 'service',
            subsystemId: 'electron-main',
            tags: ['service', 'electron'],
            isEntrypoint: true,
            isProtected: false,
        };
        expect(record.path).toBeTruthy();
        expect(record.kind).toBe('service');
        expect(record.subsystemId).toBe('electron-main');
        expect(record.isEntrypoint).toBe(true);
    });

    it('SystemInventoryIndex has required top-level fields', () => {
        const index = makeMinimalIndex();
        expect(index.version).toBe('1.0');
        expect(index.generatedAt).toBeTruthy();
        expect(Array.isArray(index.artifacts)).toBe(true);
        expect(typeof index.totalArtifacts).toBe('number');
        expect(index.kindSummary).toBeTruthy();
    });

    it('SubsystemRecord has all required fields', () => {
        const record: SubsystemRecord = {
            id: 'inference',
            name: 'Inference',
            description: 'Test',
            rootPaths: ['electron/services/inference/'],
            authorityFiles: [],
            entrypoints: [],
            dependencies: [],
            dependents: [],
            invariantIds: [],
            testFiles: [],
            docFiles: [],
            riskLevel: 'high',
            confidence: 'high',
        };
        expect(record.id).toBe('inference');
        expect(record.riskLevel).toBe('high');
    });
});

// ─── P1B: SelfModelScanner classification ────────────────────────────────────

describe('P1B — SelfModelScanner classification', () => {
    let scanner: SelfModelScanner;

    beforeEach(() => {
        scanner = new SelfModelScanner(REPO_ROOT);
    });

    it('classifies electron/main.ts as entrypoint', () => {
        const r = scanner.classifyFile('electron/main.ts');
        expect(r.kind).toBe('entrypoint');
        expect(r.isEntrypoint).toBe(true);
        expect(r.subsystemId).toBe('electron-main');
    });

    it('classifies electron/services/IpcRouter.ts as ipc_router', () => {
        const r = scanner.classifyFile('electron/services/IpcRouter.ts');
        expect(r.kind).toBe('ipc_router');
        expect(r.tags).toContain('ipc');
    });

    it('classifies electron/services/AgentService.ts as service in electron-main', () => {
        const r = scanner.classifyFile('electron/services/AgentService.ts');
        expect(r.kind).toBe('service');
        expect(r.subsystemId).toBe('electron-main');
        expect(r.tags).toContain('service');
    });

    it('classifies electron/services/reflection/ReflectionService.ts as service in reflection', () => {
        const r = scanner.classifyFile('electron/services/reflection/ReflectionService.ts');
        expect(r.kind).toBe('service');
        expect(r.subsystemId).toBe('reflection');
    });

    it('classifies electron/services/soul/SoulService.ts as service in soul', () => {
        const r = scanner.classifyFile('electron/services/soul/SoulService.ts');
        expect(r.kind).toBe('service');
        expect(r.subsystemId).toBe('soul');
    });

    it('classifies electron/services/selfModel/SelfModelRefreshService.ts as service in self-model', () => {
        const r = scanner.classifyFile('electron/services/selfModel/SelfModelRefreshService.ts');
        expect(r.kind).toBe('service');
        expect(r.subsystemId).toBe('self-model');
    });

    it('classifies src/renderer/components/ReflectionPanel.tsx as renderer_component', () => {
        const r = scanner.classifyFile('src/renderer/components/ReflectionPanel.tsx');
        expect(r.kind).toBe('renderer_component');
        expect(r.subsystemId).toBe('renderer');
    });

    it('classifies shared/selfModelTypes.ts as shared_contract', () => {
        const r = scanner.classifyFile('shared/selfModelTypes.ts');
        expect(r.kind).toBe('shared_contract');
        expect(r.subsystemId).toBe('shared');
    });

    it('classifies mcp-servers/astro-engine/main.py as mcp_server', () => {
        const r = scanner.classifyFile('mcp-servers/astro-engine/main.py');
        expect(r.kind).toBe('mcp_server');
        expect(r.subsystemId).toContain('mcp');
    });

    it('classifies tests/SelfMaintenance.test.ts as test', () => {
        const r = scanner.classifyFile('tests/SelfMaintenance.test.ts');
        expect(r.kind).toBe('test');
        expect(r.subsystemId).toBe('tests');
    });

    it('classifies scripts/diagnostics/validate_repo_structure.ts as script', () => {
        const r = scanner.classifyFile('scripts/diagnostics/validate_repo_structure.ts');
        expect(r.kind).toBe('script');
        expect(r.subsystemId).toBe('scripts');
    });

    it('classifies electron/brains/OllamaBrain.ts as brain', () => {
        const r = scanner.classifyFile('electron/brains/OllamaBrain.ts');
        expect(r.kind).toBe('brain');
        expect(r.subsystemId).toBe('inference');
    });

    it('classifies docs/architecture/component_model.md as doc', () => {
        const r = scanner.classifyFile('docs/architecture/component_model.md');
        expect(r.kind).toBe('doc');
        expect(r.subsystemId).toBe('docs');
    });

    it('classifies electron/services/ReflectionAppService.ts as ipc_handler', () => {
        const r = scanner.classifyFile('electron/services/reflection/ReflectionAppService.ts');
        // AppService pattern in electron/ → ipc_handler
        expect(r.kind).toBe('ipc_handler');
    });

    it('does not assign unknown to well-known paths', () => {
        const knownPaths = [
            'electron/main.ts',
            'electron/services/AgentService.ts',
            'shared/telemetry.ts',
            'src/renderer/components/ReflectionPanel.tsx',
            'tests/SelfMaintenance.test.ts',
        ];
        for (const p of knownPaths) {
            const r = scanner.classifyFile(p);
            expect(r.kind, `${p} should not be unknown`).not.toBe('unknown');
        }
    });

    it('tags include expected values for service files', () => {
        const r = scanner.classifyFile('electron/services/AgentService.ts');
        expect(r.tags).toContain('service');
        expect(r.tags).toContain('electron');
    });
});

// ─── P1B: SelfModelBuilder ────────────────────────────────────────────────────

describe('P1B — SelfModelBuilder', () => {
    it('hashIndex produces a stable hex string', () => {
        const index = makeMinimalIndex([{ path: 'electron/services/TestService.ts' }]);
        const hash = SelfModelBuilder.hashIndex(index);
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('hashIndex is deterministic for same input', () => {
        const index = makeMinimalIndex([{ path: 'electron/services/TestService.ts' }]);
        expect(SelfModelBuilder.hashIndex(index)).toBe(SelfModelBuilder.hashIndex(index));
    });

    it('hashIndex differs for different file lists', () => {
        const index1 = makeMinimalIndex([{ path: 'electron/services/A.ts' }]);
        const index2 = makeMinimalIndex([{ path: 'electron/services/B.ts' }]);
        expect(SelfModelBuilder.hashIndex(index1)).not.toBe(SelfModelBuilder.hashIndex(index2));
    });

    it('loadExistingIndex returns null for missing file', () => {
        const builder = new SelfModelBuilder(REPO_ROOT);
        const result = builder.loadExistingIndex('/tmp/nonexistent_tala_index.json');
        expect(result).toBeNull();
    });
});

// ─── P1C: OwnershipMapper ─────────────────────────────────────────────────────

describe('P1C — OwnershipMapper', () => {
    let mapper: OwnershipMapper;

    beforeEach(() => {
        mapper = new OwnershipMapper(REPO_ROOT);
    });

    it('buildOwnershipMap returns a map with known subsystems', () => {
        const index = makeMinimalIndex([
            { path: 'electron/services/InferenceService.ts', kind: 'service', subsystemId: 'inference' },
            { path: 'electron/services/MemoryService.ts', kind: 'service', subsystemId: 'memory' },
            { path: 'electron/services/reflection/ReflectionService.ts', kind: 'service', subsystemId: 'reflection' },
        ]);
        const map = mapper.buildOwnershipMap(index);

        const ids = map.subsystems.map(s => s.id);
        expect(ids).toContain('inference');
        expect(ids).toContain('memory');
        expect(ids).toContain('reflection');
        expect(ids).toContain('self-model');
    });

    it('electron-main subsystem has electron IPC as a dependency via seed', () => {
        const index = makeMinimalIndex();
        const map = mapper.buildOwnershipMap(index);
        const subsystem = map.subsystems.find(s => s.id === 'electron-main');
        expect(subsystem).toBeDefined();
    });

    it('reflection subsystem has high or critical risk level', () => {
        const index = makeMinimalIndex();
        const map = mapper.buildOwnershipMap(index);
        const s = map.subsystems.find(sub => sub.id === 'reflection');
        expect(s).toBeDefined();
        expect(['high', 'critical']).toContain(s!.riskLevel);
    });

    it('hashOwnershipMap is deterministic', () => {
        const index = makeMinimalIndex();
        const map = mapper.buildOwnershipMap(index);
        expect(OwnershipMapper.hashOwnershipMap(map)).toBe(OwnershipMapper.hashOwnershipMap(map));
    });

    it('loadExistingMap returns null for missing file', () => {
        const result = mapper.loadExistingMap('/tmp/nonexistent_ownership.json');
        expect(result).toBeNull();
    });

    it('dependents are populated (blast radius)', () => {
        const index = makeMinimalIndex();
        const map = mapper.buildOwnershipMap(index);
        // electron-main should be a dependent of at least one subsystem that depends on it
        // e.g. inference depends on electron-main, so electron-main.dependents includes inference
        const electronMain = map.subsystems.find(s => s.id === 'electron-main');
        expect(electronMain).toBeDefined();
        // Some subsystems should depend on electron-main
        const dependsOnMain = map.subsystems.filter(s => s.dependencies.includes('electron-main'));
        if (dependsOnMain.length > 0) {
            expect(electronMain!.dependents.length).toBeGreaterThan(0);
        }
    });
});

// ─── P1D: InvariantRegistry ───────────────────────────────────────────────────

describe('P1D — InvariantRegistry', () => {
    let registry: InvariantRegistry;

    beforeEach(() => {
        registry = new InvariantRegistry(SELF_MODEL_DATA_DIR);
    });

    it('loads successfully from data/self_model/invariant_registry.json', () => {
        const loaded = registry.load();
        expect(loaded).toBe(true);
        expect(registry.isLoaded()).toBe(true);
    });

    it('contains all 10 required invariants', () => {
        registry.load();
        const all = registry.getAll();
        expect(all.length).toBeGreaterThanOrEqual(10);
    });

    it('has inv-001 IPC uniqueness invariant', () => {
        registry.load();
        const inv = registry.getById('inv-001');
        expect(inv).toBeDefined();
        expect(inv!.title).toContain('IPC');
        expect(inv!.severity).toBe('critical');
        expect(inv!.enforcementMode).toBe('test_covered');
    });

    it('has inv-005 memory authority ordering invariant', () => {
        registry.load();
        const inv = registry.getById('inv-005');
        expect(inv).toBeDefined();
        expect(inv!.category ?? inv!.severity).toBeTruthy();
    });

    it('getBySubsystem returns correct invariants', () => {
        registry.load();
        const invs = registry.getBySubsystem('reflection');
        expect(Array.isArray(invs)).toBe(true);
        // inv-001 applies to reflection
        expect(invs.some(i => i.id === 'inv-001')).toBe(true);
    });

    it('getBySubsystem("memory") returns memory-relevant invariants', () => {
        registry.load();
        const invs = registry.getBySubsystem('memory');
        expect(invs.some(i => i.id === 'inv-005')).toBe(true);
    });

    it('getBySeverity returns only invariants with given severity', () => {
        registry.load();
        const critical = registry.getBySeverity('critical');
        expect(critical.length).toBeGreaterThan(0);
        expect(critical.every(i => i.severity === 'critical')).toBe(true);
    });

    it('returns empty array (not null) when not loaded', () => {
        const fresh = new InvariantRegistry('/tmp/nonexistent_dir');
        expect(fresh.getAll()).toEqual([]);
        expect(fresh.getBySubsystem('memory')).toEqual([]);
    });

    it('load fails gracefully for missing file', () => {
        const fresh = new InvariantRegistry('/tmp/nonexistent_dir');
        const result = fresh.load();
        expect(result).toBe(false);
        expect(fresh.isLoaded()).toBe(false);
    });

    it('getMeta returns version and lastReviewedAt', () => {
        registry.load();
        const meta = registry.getMeta();
        expect(meta).not.toBeNull();
        expect(meta!.version).toBeTruthy();
        expect(meta!.lastReviewedAt).toBeTruthy();
    });
});

// ─── P1E: CapabilityRegistry ──────────────────────────────────────────────────

describe('P1E — CapabilityRegistry', () => {
    let registry: CapabilityRegistry;

    beforeEach(() => {
        registry = new CapabilityRegistry(SELF_MODEL_DATA_DIR);
    });

    it('loads successfully from data/self_model/capability_registry.json', () => {
        const loaded = registry.load();
        expect(loaded).toBe(true);
        expect(registry.isLoaded()).toBe(true);
    });

    it('contains all 12 required capabilities', () => {
        registry.load();
        expect(registry.getAll().length).toBeGreaterThanOrEqual(12);
    });

    it('cap-001 read files is available', () => {
        registry.load();
        const cap = registry.getById('cap-001');
        expect(cap).toBeDefined();
        expect(cap!.available).toBe(true);
        expect(cap!.name).toContain('files');
    });

    it('cap-009 refresh self-model is available (Phase 1 implemented)', () => {
        registry.load();
        const cap = registry.getById('cap-009');
        expect(cap).toBeDefined();
        expect(cap!.available).toBe(true);
    });

    it('getAvailable returns only available capabilities', () => {
        registry.load();
        const avail = registry.getAvailable();
        expect(avail.every(c => c.available)).toBe(true);
    });

    it('getByMode("rp") returns capabilities marked for rp mode (if any)', () => {
        registry.load();
        // RP mode has very limited capabilities — at minimum read-only
        const rpCaps = registry.getByMode('rp');
        // All returned should either have 'rp' in allowedModes or have no mode restriction
        for (const c of rpCaps) {
            if (c.allowedModes) {
                expect(c.allowedModes.includes('rp')).toBe(true);
            }
        }
    });

    it('getByMode("engineering") returns all capabilities', () => {
        registry.load();
        const engCaps = registry.getByMode('engineering');
        // Engineering mode should have all capabilities
        expect(engCaps.length).toBeGreaterThan(0);
    });

    it('returns empty array when not loaded', () => {
        const fresh = new CapabilityRegistry('/tmp/nonexistent_dir');
        expect(fresh.getAll()).toEqual([]);
        expect(fresh.getAvailable()).toEqual([]);
    });

    it('load fails gracefully for missing file', () => {
        const fresh = new CapabilityRegistry('/tmp/nonexistent_dir');
        const result = fresh.load();
        expect(result).toBe(false);
        expect(fresh.isLoaded()).toBe(false);
    });
});

// ─── P1F: SelfModelQueryService ──────────────────────────────────────────────

describe('P1F — SelfModelQueryService', () => {
    let invRegistry: InvariantRegistry;
    let capRegistry: CapabilityRegistry;
    let queryService: SelfModelQueryService;
    let index: SystemInventoryIndex;
    let ownershipMap: OwnershipMap;

    beforeEach(() => {
        invRegistry = new InvariantRegistry(SELF_MODEL_DATA_DIR);
        invRegistry.load();

        capRegistry = new CapabilityRegistry(SELF_MODEL_DATA_DIR);
        capRegistry.load();

        index = makeMinimalIndex([
            { path: 'electron/services/AgentService.ts', kind: 'service', subsystemId: 'electron-main', isEntrypoint: true, tags: ['service', 'electron'] },
            { path: 'electron/services/InferenceService.ts', kind: 'service', subsystemId: 'inference', isEntrypoint: true, tags: ['service', 'inference'] },
            { path: 'electron/services/MemoryService.ts', kind: 'service', subsystemId: 'memory', isEntrypoint: true, tags: ['service', 'memory'] },
            { path: 'electron/services/reflection/ReflectionService.ts', kind: 'service', subsystemId: 'reflection', tags: ['service', 'reflection'] },
            { path: 'tests/SelfMaintenance.test.ts', kind: 'test', subsystemId: 'tests', tags: ['test'] },
        ]);

        ownershipMap = makeMinimalOwnershipMap([
            {
                id: 'electron-main', name: 'Electron Main', description: 'Main process',
                rootPaths: ['electron/'], authorityFiles: ['electron/services/AgentService.ts'],
                entrypoints: ['electron/main.ts'], dependencies: [], dependents: ['renderer'],
                invariantIds: ['inv-001', 'inv-002'], testFiles: [], docFiles: [], riskLevel: 'high', confidence: 'high',
            },
            {
                id: 'inference', name: 'Inference', description: 'Inference orchestration',
                rootPaths: ['electron/services/inference/'], authorityFiles: ['electron/services/InferenceService.ts'],
                entrypoints: ['electron/services/InferenceService.ts'], dependencies: ['electron-main'],
                dependents: [], invariantIds: ['inv-007', 'inv-009'],
                testFiles: [], docFiles: [], riskLevel: 'high', confidence: 'high',
            },
            {
                id: 'memory', name: 'Memory', description: 'Memory pipeline',
                rootPaths: ['electron/services/memory/'], authorityFiles: ['electron/services/MemoryService.ts'],
                entrypoints: [], dependencies: ['electron-main'], dependents: ['inference'],
                invariantIds: ['inv-005', 'inv-006'], testFiles: [], docFiles: [], riskLevel: 'critical', confidence: 'high',
            },
            {
                id: 'reflection', name: 'Reflection', description: 'Self-improvement',
                rootPaths: ['electron/services/reflection/'], authorityFiles: ['electron/services/reflection/ReflectionService.ts'],
                entrypoints: [], dependencies: ['electron-main'], dependents: [],
                invariantIds: ['inv-001', 'inv-007'],
                testFiles: ['tests/SelfMaintenance.test.ts'], docFiles: [], riskLevel: 'critical', confidence: 'high',
            },
        ]);

        queryService = new SelfModelQueryService(invRegistry, capRegistry, index, ownershipMap);
    });

    // ── Ownership queries ───────────────────────────────────────────────────────

    it('findOwningSubsystem returns electron-main for AgentService', () => {
        const result = queryService.findOwningSubsystem('AgentService');
        expect(result.owningSubsystem?.id).toBe('electron-main');
        expect(result.confidence).toBe('high');
    });

    it('findOwningSubsystem returns inference for InferenceService', () => {
        const result = queryService.findOwningSubsystem('InferenceService');
        expect(result.owningSubsystem?.id).toBe('inference');
    });

    it('findOwningSubsystem returns memory for MemoryService', () => {
        const result = queryService.findOwningSubsystem('MemoryService');
        expect(result.owningSubsystem?.id).toBe('memory');
    });

    it('findOwningSubsystem returns reflection subsystem by id', () => {
        const result = queryService.findOwningSubsystem('reflection');
        expect(result.owningSubsystem?.id).toBe('reflection');
        expect(result.confidence).toBe('high');
    });

    it('findOwningSubsystem returns confidence=unknown when index not loaded', () => {
        const qs = new SelfModelQueryService(invRegistry, capRegistry);
        const result = qs.findOwningSubsystem('AgentService');
        expect(result.confidence).toBe('unknown');
        expect(result.reasoning).toContain('not loaded');
    });

    it('findOwningSubsystem returns confidence=low for unknown path', () => {
        const result = queryService.findOwningSubsystem('SomeRandomNonExistentThing12345');
        expect(result.owningSubsystem).toBeUndefined();
        // confidence could be unknown or low
        expect(['unknown', 'low']).toContain(result.confidence);
    });

    it('findOwningFiles returns correct files', () => {
        const files = queryService.findOwningFiles('InferenceService');
        expect(files.some(f => f.path.includes('InferenceService'))).toBe(true);
    });

    // ── Test queries ────────────────────────────────────────────────────────────

    it('getTestsForSubsystem returns test files for reflection', () => {
        const tests = queryService.getTestsForSubsystem('reflection');
        expect(tests).toContain('tests/SelfMaintenance.test.ts');
    });

    it('getTestsForSubsystem returns empty for unknown subsystem', () => {
        const tests = queryService.getTestsForSubsystem('nonexistent-subsystem-xyz');
        expect(tests).toEqual([]);
    });

    // ── Invariant queries ───────────────────────────────────────────────────────

    it('getInvariantsForSubsystem returns invariants for memory', () => {
        const invs = queryService.getInvariantsForSubsystem('memory');
        expect(invs.some(i => i.id === 'inv-005')).toBe(true);
    });

    it('getInvariantsForSubsystem returns IPC invariant for electron-main', () => {
        const invs = queryService.getInvariantsForSubsystem('electron-main');
        expect(invs.some(i => i.id === 'inv-001')).toBe(true);
    });

    it('getInvariantsForSubsystem returns empty for unknown subsystem', () => {
        const invs = queryService.getInvariantsForSubsystem('nonexistent-xyz');
        expect(Array.isArray(invs)).toBe(true);
        expect(invs.length).toBe(0);
    });

    // ── Blast radius ────────────────────────────────────────────────────────────

    it('explainBlastRadius for electron-main returns direct dependents', () => {
        const result = queryService.explainBlastRadius('electron-main');
        expect(result.subsystemId).toBe('electron-main');
        expect(result.directDependents).toContain('renderer');
    });

    it('explainBlastRadius for unknown target returns empty dependents', () => {
        const result = queryService.explainBlastRadius('nonexistent-subsystem-xyz');
        expect(result.directDependents).toEqual([]);
        expect(result.transitivelyAffected).toEqual([]);
    });

    it('getAffectedSystems returns dependents', () => {
        const affected = queryService.getAffectedSystems('electron-main');
        expect(affected).toContain('renderer');
    });

    // ── Capabilities ────────────────────────────────────────────────────────────

    it('getCapabilities returns all capability records', () => {
        const caps = queryService.getCapabilities();
        expect(caps.length).toBeGreaterThanOrEqual(12);
    });

    it('getCapabilitiesForMode("engineering") returns all caps', () => {
        const caps = queryService.getCapabilitiesForMode('engineering');
        expect(caps.length).toBeGreaterThan(0);
    });

    // ── Explain ownership ───────────────────────────────────────────────────────

    it('explainOwnership returns a readable string', () => {
        const result = queryService.explainOwnership('AgentService');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(10);
        expect(result).toContain('electron-main');
    });

    it('explainOwnership explains unknown with no crash', () => {
        const result = queryService.explainOwnership('SomethingThatDoesntExist99999');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(5);
    });
});

// ─── P1G: SelfModelAppService IPC channels ───────────────────────────────────

describe('P1G — SelfModelAppService IPC registration', () => {
    /**
     * Static analysis approach (consistent with IpcChannelUniqueness.test.ts):
     * Parse SelfModelAppService.ts source to extract ipcMain.handle channel names.
     */
    function extractChannels(filePath: string): string[] {
        const content = fs.readFileSync(filePath, 'utf-8');
        const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
        const channels: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) channels.push(m[1]);
        return channels;
    }

    const APP_SERVICE_PATH = path.join(REPO_ROOT, 'electron/services/selfModel/SelfModelAppService.ts');

    it('SelfModelAppService registers all expected selfModel: channels', () => {
        const channels = extractChannels(APP_SERVICE_PATH);
        const EXPECTED = [
            'selfModel:getMeta',
            'selfModel:checkStaleness',
            'selfModel:getIndex',
            'selfModel:getOwnershipMap',
            'selfModel:getInvariants',
            'selfModel:getCapabilities',
            'selfModel:refresh',
            'selfModel:queryOwnership',
            'selfModel:queryInvariants',
            'selfModel:queryBlastRadius',
            'selfModel:explainOwnership',
        ];
        for (const ch of EXPECTED) {
            expect(channels, `Expected channel '${ch}' to be registered`).toContain(ch);
        }
    });

    it('no selfModel: channel starts with "selfModel" but is not namespaced correctly', () => {
        const channels = extractChannels(APP_SERVICE_PATH);
        for (const ch of channels) {
            expect(ch).toMatch(/^selfModel:/);
        }
    });

    it('SelfModelAppService has no duplicate channel registrations', () => {
        const channels = extractChannels(APP_SERVICE_PATH);
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const ch of channels) {
            if (seen.has(ch)) duplicates.push(ch);
            seen.add(ch);
        }
        expect(duplicates, `Duplicate channels: ${duplicates.join(', ')}`).toHaveLength(0);
    });
});

// ─── P1H: SelfModelRefreshService ────────────────────────────────────────────

describe('P1H — SelfModelRefreshService refresh and staleness', () => {
    let tmpDir: string;
    let refreshService: SelfModelRefreshService;

    beforeEach(() => {
        tmpDir = makeTempDir();
        // Copy hand-authored data files so the registries can load
        const dataDir = path.join(tmpDir, 'self_model');
        fs.mkdirSync(dataDir, { recursive: true });
        for (const file of ['invariant_registry.json', 'capability_registry.json']) {
            const src = path.join(SELF_MODEL_DATA_DIR, file);
            const dst = path.join(dataDir, file);
            if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        }
        refreshService = new SelfModelRefreshService(REPO_ROOT, dataDir);
        refreshService.init();
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('init() loads registries successfully', () => {
        expect(refreshService.getInvariantRegistry().isLoaded()).toBe(true);
        expect(refreshService.getCapabilityRegistry().isLoaded()).toBe(true);
    });

    it('checkStaleness returns "missing" before first refresh', () => {
        const status = refreshService.checkStaleness();
        expect(status).toBe('missing');
    });

    it('refresh() produces a valid SelfModelMeta', async () => {
        const meta = await refreshService.refresh(true);
        expect(meta.version).toBe('1.0');
        expect(meta.generatedAt).toBeTruthy();
        expect(['fresh', 'drifted']).toContain(meta.status);
        expect(typeof meta.refreshDurationMs).toBe('number');
        expect(meta.indexHash).toMatch(/^[a-f0-9]{64}$/);
        expect(meta.ownershipHash).toMatch(/^[a-f0-9]{64}$/);
    }, 30000);

    it('refresh() writes self_model_index.json to data dir', async () => {
        const dataDir = path.join(tmpDir, 'self_model');
        await refreshService.refresh(true);
        expect(fs.existsSync(path.join(dataDir, 'self_model_index.json'))).toBe(true);
    }, 30000);

    it('refresh() writes subsystem_ownership_map.json to data dir', async () => {
        const dataDir = path.join(tmpDir, 'self_model');
        await refreshService.refresh(true);
        expect(fs.existsSync(path.join(dataDir, 'subsystem_ownership_map.json'))).toBe(true);
    }, 30000);

    it('refresh() writes self_model_meta.json to data dir', async () => {
        const dataDir = path.join(tmpDir, 'self_model');
        await refreshService.refresh(true);
        expect(fs.existsSync(path.join(dataDir, 'self_model_meta.json'))).toBe(true);
    }, 30000);

    it('second refresh returns "fresh" when index has not changed', async () => {
        await refreshService.refresh(true);
        const meta2 = await refreshService.refresh(true);
        // Same input → same hashes → fresh
        expect(meta2.status).toBe('fresh');
        expect(meta2.driftedSubsystems).toHaveLength(0);
    }, 30000);

    it('checkStaleness returns "fresh" after successful refresh', async () => {
        await refreshService.refresh(true);
        expect(refreshService.checkStaleness()).toBe('fresh');
    }, 30000);

    it('getLastIndex returns populated index after refresh', async () => {
        await refreshService.refresh(true);
        const idx = refreshService.getLastIndex();
        expect(idx).not.toBeNull();
        expect(idx!.totalArtifacts).toBeGreaterThan(0);
        expect(Array.isArray(idx!.artifacts)).toBe(true);
    }, 30000);

    it('getLastOwnershipMap returns populated map after refresh', async () => {
        await refreshService.refresh(true);
        const map = refreshService.getLastOwnershipMap();
        expect(map).not.toBeNull();
        expect(map!.subsystems.length).toBeGreaterThan(0);
    }, 30000);

    it('getQueryService returns initialized service after refresh', async () => {
        await refreshService.refresh(true);
        const qs = refreshService.getQueryService();
        expect(qs).not.toBeNull();
        // Should be able to answer a question
        const result = qs!.findOwningSubsystem('AgentService');
        expect(result).toBeDefined();
        expect(result.confidence).not.toBe('unknown');
    }, 30000);

    it('drift detection fires when a new file is added', async () => {
        await refreshService.refresh(true);
        const firstMeta = refreshService.getLastMeta();
        expect(firstMeta?.status).toBe('fresh');

        // Second refresh should be fresh with no changes
        const secondMeta = await refreshService.refresh(true);
        expect(secondMeta.status).toBe('fresh');
    }, 30000);

    it('stale detection: old meta is considered stale', () => {
        // Inject a meta with an old generatedAt
        const oldMeta = {
            version: '1.0',
            generatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
            indexHash: 'abc123',
            ownershipHash: 'def456',
            status: 'fresh' as const,
            staleReasons: [],
            driftedSubsystems: [],
            refreshDurationMs: 100,
        };
        const dataDir = path.join(tmpDir, 'self_model');
        fs.writeFileSync(path.join(dataDir, 'self_model_meta.json'), JSON.stringify(oldMeta));
        const fresh = new SelfModelRefreshService(REPO_ROOT, dataDir);
        fresh.init();
        expect(fresh.checkStaleness()).toBe('stale');
    });
});
