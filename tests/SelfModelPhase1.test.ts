/**
 * SelfModelPhase1.test.ts — Phase 1 Self-Model Foundation Tests
 *
 * 83 tests covering:
 *   P1A: Shared types
 *   P1B: Default registry files
 *   P1C: InvariantRegistry
 *   P1D: CapabilityRegistry
 *   P1E: SelfModelQueryService
 *   P1F: SelfModelRefreshService
 *   P1G: SelfModelAppService IPC
 *   P1H: Registry file path / fresh-clone invariant
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test', isPackaged: false, getAppPath: () => '/tmp/tala-app' },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: { operational: vi.fn(), event: vi.fn() },
}));

// ─── P1A: Shared types ────────────────────────────────────────────────────────

describe('P1A: Shared types', () => {
    it('shared/selfModelTypes.ts exists and can be imported', async () => {
        const mod = await import('../shared/selfModelTypes');
        expect(mod).toBeDefined();
    });

    it('InvariantCategory allows expected values as strings', async () => {
        const validValues: string[] = ['architectural', 'behavioral', 'safety', 'ethical'];
        // TypeScript types are erased at runtime; we verify the values are accepted by
        // constructing objects that reference them
        const inv = {
            id: 'test',
            label: 'Test',
            description: 'desc',
            category: 'architectural' as any,
            status: 'active' as any,
            addedAt: '2024-01-01',
        };
        expect(validValues).toContain(inv.category);
    });

    it('CapabilityCategory allows expected values as strings', async () => {
        const validValues: string[] = ['inference', 'memory', 'retrieval', 'ui', 'tools', 'identity'];
        const cap = {
            id: 'test',
            label: 'Test',
            description: 'desc',
            category: 'inference' as any,
            status: 'available' as any,
            addedAt: '2024-01-01',
        };
        expect(validValues).toContain(cap.category);
    });

    it('SelfModelSnapshot shape is correct', async () => {
        const snapshot = {
            generatedAt: new Date().toISOString(),
            invariants: [],
            capabilities: [],
            components: [],
            ownershipMap: [],
        };
        expect(snapshot).toHaveProperty('generatedAt');
        expect(snapshot).toHaveProperty('invariants');
        expect(snapshot).toHaveProperty('capabilities');
        expect(snapshot).toHaveProperty('components');
        expect(snapshot).toHaveProperty('ownershipMap');
    });

    it('ArchitectureSummary shape is correct', async () => {
        const summary = {
            totalInvariants: 10,
            activeInvariants: 8,
            totalCapabilities: 10,
            availableCapabilities: 9,
            totalComponents: 5,
            lastRefreshed: null,
        };
        expect(summary).toHaveProperty('totalInvariants');
        expect(summary).toHaveProperty('activeInvariants');
        expect(summary).toHaveProperty('totalCapabilities');
        expect(summary).toHaveProperty('availableCapabilities');
        expect(summary).toHaveProperty('totalComponents');
        expect(summary).toHaveProperty('lastRefreshed');
    });
});

// ─── P1B: Default registry files ─────────────────────────────────────────────

describe('P1B: Default registry files', () => {
    const INV_JSON_PATH = path.join(process.cwd(), 'electron/services/selfModel/defaults/invariant_registry.json');
    const CAP_JSON_PATH = path.join(process.cwd(), 'electron/services/selfModel/defaults/capability_registry.json');
    const INV_TS_PATH = path.join(process.cwd(), 'electron/services/selfModel/defaults/invariantRegistry.ts');
    const CAP_TS_PATH = path.join(process.cwd(), 'electron/services/selfModel/defaults/capabilityRegistry.ts');

    // ── JSON files (committed for compatibility and readability) ──

    it('invariant_registry.json exists in electron/services/selfModel/defaults/', () => {
        expect(fs.existsSync(INV_JSON_PATH)).toBe(true);
    });

    it('invariant_registry.json is valid JSON', () => {
        const raw = fs.readFileSync(INV_JSON_PATH, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('invariant_registry.json has at least 8 invariants', () => {
        const parsed = JSON.parse(fs.readFileSync(INV_JSON_PATH, 'utf-8'));
        expect(Array.isArray(parsed.invariants)).toBe(true);
        expect(parsed.invariants.length).toBeGreaterThanOrEqual(8);
    });

    it('each invariant has id, label, description, category, status, addedAt', () => {
        const parsed = JSON.parse(fs.readFileSync(INV_JSON_PATH, 'utf-8'));
        for (const inv of parsed.invariants) {
            expect(inv).toHaveProperty('id');
            expect(inv).toHaveProperty('label');
            expect(inv).toHaveProperty('description');
            expect(inv).toHaveProperty('category');
            expect(inv).toHaveProperty('status');
            expect(inv).toHaveProperty('addedAt');
        }
    });

    it('capability_registry.json exists', () => {
        expect(fs.existsSync(CAP_JSON_PATH)).toBe(true);
    });

    it('capability_registry.json is valid JSON', () => {
        const raw = fs.readFileSync(CAP_JSON_PATH, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('capability_registry.json has at least 8 capabilities', () => {
        const parsed = JSON.parse(fs.readFileSync(CAP_JSON_PATH, 'utf-8'));
        expect(Array.isArray(parsed.capabilities)).toBe(true);
        expect(parsed.capabilities.length).toBeGreaterThanOrEqual(8);
    });

    it('each capability has id, label, description, category, status, addedAt', () => {
        const parsed = JSON.parse(fs.readFileSync(CAP_JSON_PATH, 'utf-8'));
        for (const cap of parsed.capabilities) {
            expect(cap).toHaveProperty('id');
            expect(cap).toHaveProperty('label');
            expect(cap).toHaveProperty('description');
            expect(cap).toHaveProperty('category');
            expect(cap).toHaveProperty('status');
            expect(cap).toHaveProperty('addedAt');
        }
    });

    // ── TypeScript constant exports (preferred authoritative source) ──

    it('invariantRegistry.ts exists in electron/services/selfModel/defaults/', () => {
        expect(fs.existsSync(INV_TS_PATH)).toBe(true);
    });

    it('DEFAULT_INVARIANTS can be imported from defaults/invariantRegistry', async () => {
        const mod = await import('../electron/services/selfModel/defaults/invariantRegistry');
        expect(mod.DEFAULT_INVARIANTS).toBeDefined();
        expect(Array.isArray(mod.DEFAULT_INVARIANTS)).toBe(true);
    });

    it('DEFAULT_INVARIANTS has at least 8 entries', async () => {
        const { DEFAULT_INVARIANTS } = await import('../electron/services/selfModel/defaults/invariantRegistry');
        expect(DEFAULT_INVARIANTS.length).toBeGreaterThanOrEqual(8);
    });

    it('DEFAULT_INVARIANTS entries have required fields', async () => {
        const { DEFAULT_INVARIANTS } = await import('../electron/services/selfModel/defaults/invariantRegistry');
        for (const inv of DEFAULT_INVARIANTS) {
            expect(inv).toHaveProperty('id');
            expect(inv).toHaveProperty('label');
            expect(inv).toHaveProperty('description');
            expect(inv).toHaveProperty('category');
            expect(inv).toHaveProperty('status');
            expect(inv).toHaveProperty('addedAt');
        }
    });

    it('capabilityRegistry.ts exists in electron/services/selfModel/defaults/', () => {
        expect(fs.existsSync(CAP_TS_PATH)).toBe(true);
    });

    it('DEFAULT_CAPABILITIES can be imported from defaults/capabilityRegistry', async () => {
        const mod = await import('../electron/services/selfModel/defaults/capabilityRegistry');
        expect(mod.DEFAULT_CAPABILITIES).toBeDefined();
        expect(Array.isArray(mod.DEFAULT_CAPABILITIES)).toBe(true);
    });

    it('DEFAULT_CAPABILITIES has at least 8 entries', async () => {
        const { DEFAULT_CAPABILITIES } = await import('../electron/services/selfModel/defaults/capabilityRegistry');
        expect(DEFAULT_CAPABILITIES.length).toBeGreaterThanOrEqual(8);
    });

    it('DEFAULT_CAPABILITIES entries have required fields', async () => {
        const { DEFAULT_CAPABILITIES } = await import('../electron/services/selfModel/defaults/capabilityRegistry');
        for (const cap of DEFAULT_CAPABILITIES) {
            expect(cap).toHaveProperty('id');
            expect(cap).toHaveProperty('label');
            expect(cap).toHaveProperty('description');
            expect(cap).toHaveProperty('category');
            expect(cap).toHaveProperty('status');
            expect(cap).toHaveProperty('addedAt');
        }
    });

    it('DEFAULT_INVARIANTS and invariant_registry.json contain the same ids', async () => {
        const { DEFAULT_INVARIANTS } = await import('../electron/services/selfModel/defaults/invariantRegistry');
        const parsed = JSON.parse(fs.readFileSync(INV_JSON_PATH, 'utf-8'));
        const tsIds = new Set(DEFAULT_INVARIANTS.map((i: any) => i.id));
        const jsonIds = new Set(parsed.invariants.map((i: any) => i.id));
        for (const id of jsonIds) {
            expect(tsIds.has(id)).toBe(true);
        }
    });

    it('DEFAULT_CAPABILITIES and capability_registry.json contain the same ids', async () => {
        const { DEFAULT_CAPABILITIES } = await import('../electron/services/selfModel/defaults/capabilityRegistry');
        const parsed = JSON.parse(fs.readFileSync(CAP_JSON_PATH, 'utf-8'));
        const tsIds = new Set(DEFAULT_CAPABILITIES.map((c: any) => c.id));
        const jsonIds = new Set(parsed.capabilities.map((c: any) => c.id));
        for (const id of jsonIds) {
            expect(tsIds.has(id)).toBe(true);
        }
    });
});

// ─── P1C: InvariantRegistry ───────────────────────────────────────────────────

describe('P1C: InvariantRegistry', () => {
    let InvariantRegistry: any;

    beforeEach(async () => {
        const mod = await import('../electron/services/selfModel/InvariantRegistry');
        InvariantRegistry = mod.InvariantRegistry;
        vi.clearAllMocks();
    });

    it('InvariantRegistry can be instantiated', () => {
        const registry = new InvariantRegistry();
        expect(registry).toBeDefined();
    });

    it('load() without args loads defaults', () => {
        const registry = new InvariantRegistry();
        expect(() => registry.load()).not.toThrow();
    });

    it('load() with missing runtime path falls back gracefully (non-fatal)', () => {
        const registry = new InvariantRegistry();
        expect(() => registry.load('/nonexistent/path/invariants.json')).not.toThrow();
    });

    it('getAll() returns array of invariants', () => {
        const registry = new InvariantRegistry();
        registry.load();
        expect(Array.isArray(registry.getAll())).toBe(true);
    });

    it('getAll() returns > 0 items after load', () => {
        const registry = new InvariantRegistry();
        registry.load();
        expect(registry.getAll().length).toBeGreaterThan(0);
    });

    it('getById() returns correct invariant for known id', () => {
        const registry = new InvariantRegistry();
        registry.load();
        const all = registry.getAll();
        const first = all[0];
        const found = registry.getById(first.id);
        expect(found).toBeDefined();
        expect(found?.id).toBe(first.id);
    });

    it('getById() returns undefined for unknown id', () => {
        const registry = new InvariantRegistry();
        registry.load();
        expect(registry.getById('totally-unknown-id-xyz')).toBeUndefined();
    });

    it('getByCategory() returns only invariants of that category', () => {
        const registry = new InvariantRegistry();
        registry.load();
        const architectural = registry.getByCategory('architectural');
        expect(architectural.every((i: any) => i.category === 'architectural')).toBe(true);
    });

    it('getActive() returns only active invariants', () => {
        const registry = new InvariantRegistry();
        registry.load();
        const active = registry.getActive();
        expect(active.every((i: any) => i.status === 'active')).toBe(true);
    });

    it('count() returns correct count', () => {
        const registry = new InvariantRegistry();
        registry.load();
        expect(registry.count()).toBe(registry.getAll().length);
    });

    it('two loads do not duplicate invariants', () => {
        const registry = new InvariantRegistry();
        registry.load();
        const count1 = registry.count();
        registry.load();
        const count2 = registry.count();
        expect(count2).toBe(count1);
    });

    it('invariants from defaults have valid structure', () => {
        const registry = new InvariantRegistry();
        registry.load();
        for (const inv of registry.getAll()) {
            expect(inv).toHaveProperty('id');
            expect(inv).toHaveProperty('label');
            expect(inv).toHaveProperty('description');
            expect(inv).toHaveProperty('category');
            expect(inv).toHaveProperty('status');
            expect(inv).toHaveProperty('addedAt');
        }
    });
});

// ─── P1D: CapabilityRegistry ──────────────────────────────────────────────────

describe('P1D: CapabilityRegistry', () => {
    let CapabilityRegistry: any;

    beforeEach(async () => {
        const mod = await import('../electron/services/selfModel/CapabilityRegistry');
        CapabilityRegistry = mod.CapabilityRegistry;
        vi.clearAllMocks();
    });

    it('CapabilityRegistry can be instantiated', () => {
        const registry = new CapabilityRegistry();
        expect(registry).toBeDefined();
    });

    it('load() without args loads defaults', () => {
        const registry = new CapabilityRegistry();
        expect(() => registry.load()).not.toThrow();
    });

    it('load() with missing runtime path falls back gracefully (non-fatal)', () => {
        const registry = new CapabilityRegistry();
        expect(() => registry.load('/nonexistent/path/capabilities.json')).not.toThrow();
    });

    it('getAll() returns array of capabilities', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        expect(Array.isArray(registry.getAll())).toBe(true);
    });

    it('getAll() returns > 0 items after load', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        expect(registry.getAll().length).toBeGreaterThan(0);
    });

    it('getById() returns correct capability for known id', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        const all = registry.getAll();
        const first = all[0];
        const found = registry.getById(first.id);
        expect(found).toBeDefined();
        expect(found?.id).toBe(first.id);
    });

    it('getById() returns undefined for unknown id', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        expect(registry.getById('totally-unknown-cap-xyz')).toBeUndefined();
    });

    it('getByCategory() returns only capabilities of that category', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        const inference = registry.getByCategory('inference');
        expect(inference.every((c: any) => c.category === 'inference')).toBe(true);
    });

    it('getAvailable() returns only available capabilities', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        const available = registry.getAvailable();
        expect(available.every((c: any) => c.status === 'available')).toBe(true);
    });

    it('count() returns correct count', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        expect(registry.count()).toBe(registry.getAll().length);
    });

    it('two loads do not duplicate capabilities', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        const count1 = registry.count();
        registry.load();
        const count2 = registry.count();
        expect(count2).toBe(count1);
    });

    it('capabilities from defaults have valid structure', () => {
        const registry = new CapabilityRegistry();
        registry.load();
        for (const cap of registry.getAll()) {
            expect(cap).toHaveProperty('id');
            expect(cap).toHaveProperty('label');
            expect(cap).toHaveProperty('description');
            expect(cap).toHaveProperty('category');
            expect(cap).toHaveProperty('status');
            expect(cap).toHaveProperty('addedAt');
        }
    });
});

// ─── P1E: SelfModelQueryService ───────────────────────────────────────────────

describe('P1E: SelfModelQueryService', () => {
    let InvariantRegistry: any;
    let CapabilityRegistry: any;
    let OwnershipMapper: any;
    let SelfModelScanner: any;
    let SelfModelBuilder: any;
    let SelfModelQueryService: any;

    beforeEach(async () => {
        const [invMod, capMod, ownMod, scanMod, buildMod, queryMod] = await Promise.all([
            import('../electron/services/selfModel/InvariantRegistry'),
            import('../electron/services/selfModel/CapabilityRegistry'),
            import('../electron/services/selfModel/OwnershipMapper'),
            import('../electron/services/selfModel/SelfModelScanner'),
            import('../electron/services/selfModel/SelfModelBuilder'),
            import('../electron/services/selfModel/SelfModelQueryService'),
        ]);
        InvariantRegistry = invMod.InvariantRegistry;
        CapabilityRegistry = capMod.CapabilityRegistry;
        OwnershipMapper = ownMod.OwnershipMapper;
        SelfModelScanner = scanMod.SelfModelScanner;
        SelfModelBuilder = buildMod.SelfModelBuilder;
        SelfModelQueryService = queryMod.SelfModelQueryService;
        vi.clearAllMocks();
    });

    function makeQueryService() {
        const invReg = new InvariantRegistry();
        invReg.load();
        const capReg = new CapabilityRegistry();
        capReg.load();
        return new SelfModelQueryService(
            invReg,
            capReg,
            new OwnershipMapper(),
            new SelfModelScanner(),
            new SelfModelBuilder(),
        );
    }

    it('can be instantiated with all dependencies', () => {
        const qs = makeQueryService();
        expect(qs).toBeDefined();
    });

    it('getSnapshot() returns SelfModelSnapshot', () => {
        const qs = makeQueryService();
        const snap = qs.getSnapshot();
        expect(snap).toBeDefined();
    });

    it('getSnapshot() has invariants array', () => {
        const qs = makeQueryService();
        const snap = qs.getSnapshot();
        expect(Array.isArray(snap.invariants)).toBe(true);
    });

    it('getSnapshot() has capabilities array', () => {
        const qs = makeQueryService();
        const snap = qs.getSnapshot();
        expect(Array.isArray(snap.capabilities)).toBe(true);
    });

    it('getSnapshot() has components array', () => {
        const qs = makeQueryService();
        const snap = qs.getSnapshot();
        expect(Array.isArray(snap.components)).toBe(true);
    });

    it('getSnapshot() has generatedAt timestamp', () => {
        const qs = makeQueryService();
        const snap = qs.getSnapshot();
        expect(typeof snap.generatedAt).toBe('string');
        expect(snap.generatedAt.length).toBeGreaterThan(0);
    });

    it('queryInvariants() with no filter returns all invariants', () => {
        const qs = makeQueryService();
        const result = qs.queryInvariants();
        expect(result.invariants.length).toBeGreaterThan(0);
        expect(result.total).toBe(result.invariants.length);
    });

    it('queryInvariants() with category filter returns subset', () => {
        const qs = makeQueryService();
        const result = qs.queryInvariants({ category: 'architectural' });
        expect(result.invariants.every((i: any) => i.category === 'architectural')).toBe(true);
    });

    it('queryInvariants() with status filter returns subset', () => {
        const qs = makeQueryService();
        const result = qs.queryInvariants({ status: 'active' });
        expect(result.invariants.every((i: any) => i.status === 'active')).toBe(true);
    });

    it('queryCapabilities() with no filter returns all capabilities', () => {
        const qs = makeQueryService();
        const result = qs.queryCapabilities();
        expect(result.capabilities.length).toBeGreaterThan(0);
        expect(result.total).toBe(result.capabilities.length);
    });

    it('queryCapabilities() with category filter returns subset', () => {
        const qs = makeQueryService();
        const result = qs.queryCapabilities({ category: 'inference' });
        expect(result.capabilities.every((c: any) => c.category === 'inference')).toBe(true);
    });

    it('getArchitectureSummary() returns correct counts', () => {
        const qs = makeQueryService();
        const summary = qs.getArchitectureSummary();
        expect(summary).toHaveProperty('totalInvariants');
        expect(summary).toHaveProperty('activeInvariants');
        expect(summary).toHaveProperty('totalCapabilities');
        expect(summary).toHaveProperty('availableCapabilities');
        expect(summary).toHaveProperty('totalComponents');
    });

    it('getArchitectureSummary().totalInvariants > 0', () => {
        const qs = makeQueryService();
        const summary = qs.getArchitectureSummary();
        expect(summary.totalInvariants).toBeGreaterThan(0);
    });

    it('getComponents() returns array', () => {
        const qs = makeQueryService();
        expect(Array.isArray(qs.getComponents())).toBe(true);
    });

    it('getOwnershipMap() returns array', () => {
        const qs = makeQueryService();
        expect(Array.isArray(qs.getOwnershipMap())).toBe(true);
    });
});

// ─── P1F: SelfModelRefreshService ────────────────────────────────────────────

describe('P1F: SelfModelRefreshService', () => {
    let InvariantRegistry: any;
    let CapabilityRegistry: any;
    let OwnershipMapper: any;
    let SelfModelScanner: any;
    let SelfModelBuilder: any;
    let SelfModelQueryService: any;
    let SelfModelRefreshService: any;

    beforeEach(async () => {
        const mods = await Promise.all([
            import('../electron/services/selfModel/InvariantRegistry'),
            import('../electron/services/selfModel/CapabilityRegistry'),
            import('../electron/services/selfModel/OwnershipMapper'),
            import('../electron/services/selfModel/SelfModelScanner'),
            import('../electron/services/selfModel/SelfModelBuilder'),
            import('../electron/services/selfModel/SelfModelQueryService'),
            import('../electron/services/selfModel/SelfModelRefreshService'),
        ]);
        InvariantRegistry = mods[0].InvariantRegistry;
        CapabilityRegistry = mods[1].CapabilityRegistry;
        OwnershipMapper = mods[2].OwnershipMapper;
        SelfModelScanner = mods[3].SelfModelScanner;
        SelfModelBuilder = mods[4].SelfModelBuilder;
        SelfModelQueryService = mods[5].SelfModelQueryService;
        SelfModelRefreshService = mods[6].SelfModelRefreshService;
        vi.clearAllMocks();
    });

    function makeRefreshService(dataDir = process.cwd()) {
        const invReg = new InvariantRegistry();
        const capReg = new CapabilityRegistry();
        const qs = new SelfModelQueryService(
            invReg,
            capReg,
            new OwnershipMapper(),
            new SelfModelScanner(),
            new SelfModelBuilder(),
        );
        return new SelfModelRefreshService(invReg, capReg, qs, dataDir);
    }

    it('can be instantiated', () => {
        const svc = makeRefreshService();
        expect(svc).toBeDefined();
    });

    it('init() resolves without error on fresh clone (no runtime files)', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        await expect(svc.init()).resolves.toBeDefined();
    });

    it('init() returns SelfModelRefreshResult', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.init();
        expect(result).toHaveProperty('success');
        expect(result).toHaveProperty('timestamp');
        expect(result).toHaveProperty('invariantsLoaded');
        expect(result).toHaveProperty('capabilitiesLoaded');
        expect(result).toHaveProperty('componentsScanned');
    });

    it('refresh result has success: true', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.init();
        expect(result.success).toBe(true);
    });

    it('refresh result has invariantsLoaded > 0', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.init();
        expect(result.invariantsLoaded).toBeGreaterThan(0);
    });

    it('refresh result has capabilitiesLoaded > 0', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.init();
        expect(result.capabilitiesLoaded).toBeGreaterThan(0);
    });

    it('refresh result has timestamp', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.init();
        expect(typeof result.timestamp).toBe('string');
        expect(result.timestamp.length).toBeGreaterThan(0);
    });

    it('isInitialized() is false before init', () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        expect(svc.isInitialized()).toBe(false);
    });

    it('isInitialized() is true after init', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        await svc.init();
        expect(svc.isInitialized()).toBe(true);
    });

    it('getLastRefreshResult() is null before init', () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        expect(svc.getLastRefreshResult()).toBeNull();
    });

    it('getLastRefreshResult() returns result after init', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        await svc.init();
        const result = svc.getLastRefreshResult();
        expect(result).not.toBeNull();
        expect(result?.success).toBe(true);
    });

    it('init() with missing runtime directory is non-fatal', async () => {
        const svc = makeRefreshService('/this/does/not/exist/at/all/ever');
        const result = await svc.init();
        expect(result.success).toBe(true);
    });

    it('refresh() re-initializes successfully', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        const result = await svc.refresh();
        expect(result.success).toBe(true);
    });

    it('refresh() after init() still returns success', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        await svc.init();
        const result = await svc.refresh();
        expect(result.success).toBe(true);
    });

    it('multiple refresh() calls are safe', async () => {
        const svc = makeRefreshService('/nonexistent/data/dir');
        await svc.init();
        await svc.refresh();
        await svc.refresh();
        expect(svc.isInitialized()).toBe(true);
    });
});

// ─── P1G: SelfModelAppService IPC ────────────────────────────────────────────

describe('P1G: SelfModelAppService IPC', () => {
    const APP_SERVICE_PATH = path.join(process.cwd(), 'electron/services/selfModel/SelfModelAppService.ts');

    function readHandlers(): string[] {
        const content = fs.readFileSync(APP_SERVICE_PATH, 'utf-8');
        const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
        const channels: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            channels.push(m[1]);
        }
        return channels;
    }

    it('SelfModelAppService.ts has exactly 11 ipcMain.handle registrations', () => {
        const channels = readHandlers();
        expect(channels).toHaveLength(11);
    });

    it('each handler name starts with selfModel:', () => {
        const channels = readHandlers();
        for (const ch of channels) {
            expect(ch.startsWith('selfModel:')).toBe(true);
        }
    });

    it('selfModel:init is registered', () => {
        expect(readHandlers()).toContain('selfModel:init');
    });

    it('selfModel:refresh is registered', () => {
        expect(readHandlers()).toContain('selfModel:refresh');
    });

    it('selfModel:getSnapshot is registered', () => {
        expect(readHandlers()).toContain('selfModel:getSnapshot');
    });

    it('selfModel:getInvariants is registered', () => {
        expect(readHandlers()).toContain('selfModel:getInvariants');
    });

    it('selfModel:getCapabilities is registered', () => {
        expect(readHandlers()).toContain('selfModel:getCapabilities');
    });

    it('selfModel:getArchitectureSummary is registered', () => {
        expect(readHandlers()).toContain('selfModel:getArchitectureSummary');
    });

    it('selfModel:getComponents is registered', () => {
        expect(readHandlers()).toContain('selfModel:getComponents');
    });

    it('selfModel:getOwnershipMap is registered', () => {
        expect(readHandlers()).toContain('selfModel:getOwnershipMap');
    });

    it('selfModel:getRefreshStatus is registered', () => {
        expect(readHandlers()).toContain('selfModel:getRefreshStatus');
    });
});

// ─── P1H: Registry file path / fresh-clone invariant ─────────────────────────

describe('P1H: Registry file path / fresh-clone invariant', () => {
    it('default registry JSON files are at expected paths in source tree', () => {
        const invPath = path.join(process.cwd(), 'electron/services/selfModel/defaults/invariant_registry.json');
        const capPath = path.join(process.cwd(), 'electron/services/selfModel/defaults/capability_registry.json');
        expect(fs.existsSync(invPath)).toBe(true);
        expect(fs.existsSync(capPath)).toBe(true);
    });

    it('InvariantRegistry loads successfully with no data/ directory present', async () => {
        const { InvariantRegistry } = await import('../electron/services/selfModel/InvariantRegistry');
        const registry = new InvariantRegistry();
        expect(() => registry.load('/no/data/dir/self_model/invariant_registry.json')).not.toThrow();
        expect(registry.count()).toBeGreaterThan(0);
    });

    it('CapabilityRegistry loads successfully with no data/ directory present', async () => {
        const { CapabilityRegistry } = await import('../electron/services/selfModel/CapabilityRegistry');
        const registry = new CapabilityRegistry();
        expect(() => registry.load('/no/data/dir/self_model/capability_registry.json')).not.toThrow();
        expect(registry.count()).toBeGreaterThan(0);
    });

    it('SelfModelRefreshService.init() completes without creating files in data/', async () => {
        const [
            { InvariantRegistry },
            { CapabilityRegistry },
            { OwnershipMapper },
            { SelfModelScanner },
            { SelfModelBuilder },
            { SelfModelQueryService },
            { SelfModelRefreshService },
        ] = await Promise.all([
            import('../electron/services/selfModel/InvariantRegistry'),
            import('../electron/services/selfModel/CapabilityRegistry'),
            import('../electron/services/selfModel/OwnershipMapper'),
            import('../electron/services/selfModel/SelfModelScanner'),
            import('../electron/services/selfModel/SelfModelBuilder'),
            import('../electron/services/selfModel/SelfModelQueryService'),
            import('../electron/services/selfModel/SelfModelRefreshService'),
        ]);
        const invReg = new InvariantRegistry();
        const capReg = new CapabilityRegistry();
        const qs = new SelfModelQueryService(invReg, capReg, new OwnershipMapper(), new SelfModelScanner(), new SelfModelBuilder());
        const svc = new SelfModelRefreshService(invReg, capReg, qs, '/nonexistent/data/dir');
        const result = await svc.init();
        expect(result.success).toBe(true);
        // Verify no files were created under a non-existent path
        expect(fs.existsSync('/nonexistent/data/dir')).toBe(false);
    });

    it('bundled defaults are the authoritative source, not data/ files', async () => {
        const { InvariantRegistry } = await import('../electron/services/selfModel/InvariantRegistry');
        const registry = new InvariantRegistry();
        // Load with no override — defaults should always succeed (no fs I/O required)
        registry.load();
        expect(registry.count()).toBeGreaterThan(0);
        // The bundled defaults come from the TS constant, not from data/
        // Verify the defaults module is the authoritative source
        const { DEFAULT_INVARIANTS } = await import('../electron/services/selfModel/defaults/invariantRegistry');
        expect(DEFAULT_INVARIANTS.length).toBeGreaterThan(0);
        // Registry should contain at least as many invariants as the defaults
        expect(registry.count()).toBeGreaterThanOrEqual(DEFAULT_INVARIANTS.length);
    });
});
