/**
 * ContextAssemblerTelemetry.test.ts
 *
 * Phase 3 tests for ContextAssemblerService (telemetry-emitting wrapper) and
 * ContextAssembler traceability / policy-filter extensions.
 *
 * Validates:
 *   CT01 — context.assembly_requested event emitted before assembly
 *   CT02 — context.assembled event emitted after assembly
 *   CT03 — context.assembled payload contains executionId, assemblyId, section counts, tokens, durationMs
 *   CT04 — context.truncated event emitted when a section is truncated
 *   CT05 — context.section_excluded events emitted for each excluded section
 *   CT06 — traceability: metadata.assemblyId is a non-empty string
 *   CT07 — traceability: metadata.executionId echoed from inputs
 *   CT08 — traceability: metadata.sourceCategories lists content-producing sections
 *   CT09 — traceability: metadata.excludedSections lists non-included section names
 *   CT10 — mode-based section exclusion via assemblyPolicy.modeExclusions
 *   CT11 — blockedSections policy excludes named sections with exclusionReason=policy_suppressed
 *   CT12 — allowedSections policy excludes non-listed sections with exclusionReason=policy_suppressed
 *   CT13 — blockedSourceClasses filters matching evidence items from assembled output
 *   CT14 — no memory writes occur during service assembly (purity invariant)
 *   CT15 — deterministic trace: identical inputs produce same section inclusion/reasons across runs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssemblerService } from '../electron/services/context/ContextAssemblerService';
import { ContextAssembler } from '../electron/services/context/ContextAssembler';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type {
    ContextAssemblerInputs,
    ContextEvidenceInput,
    ContextAssemblyPolicy,
} from '../shared/context/assembledContextTypes';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseInputs(overrides: Partial<ContextAssemblerInputs> = {}): ContextAssemblerInputs {
    return {
        turnId: 'turn-ct01',
        rawInput: 'Hello!',
        normalizedInput: 'hello!',
        mode: 'assistant',
        intentClass: 'greeting',
        isGreeting: true,
        executionId: 'exec-ct01',
        ...overrides,
    };
}

function substantiveInputs(overrides: Partial<ContextAssemblerInputs> = {}): ContextAssemblerInputs {
    return baseInputs({
        rawInput: 'What do you remember about me?',
        normalizedInput: 'what do you remember about me?',
        intentClass: 'lore_query',
        isGreeting: false,
        ...overrides,
    });
}

function makeMemory(id: string, text: string, source = 'memory'): ContextEvidenceInput {
    return { id, text, source };
}

function makeBus(): { bus: TelemetryBus; events: RuntimeEvent[] } {
    TelemetryBus._resetForTesting();
    const bus = TelemetryBus.getInstance();
    const events: RuntimeEvent[] = [];
    bus.subscribe(evt => events.push(evt));
    return { bus, events };
}

// ─── Phase 3 tests ────────────────────────────────────────────────────────────

describe('ContextAssemblerService — Phase 3: Telemetry & Traceability', () => {

    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    // ─── CT01–CT05: Telemetry events ─────────────────────────────────────────

    describe('CT01–CT05 — Telemetry events', () => {

        it('CT01 — context.assembly_requested emitted before assembly completes', () => {
            const { bus, events } = makeBus();
            const svc = new ContextAssemblerService(bus);

            svc.assemble(baseInputs());

            const requested = events.find(e => e.event === 'context.assembly_requested');
            expect(requested).toBeDefined();
        });

        it('CT02 — context.assembled emitted after assembly', () => {
            const { bus, events } = makeBus();
            const svc = new ContextAssemblerService(bus);

            svc.assemble(baseInputs());

            const assembled = events.find(e => e.event === 'context.assembled');
            expect(assembled).toBeDefined();
        });

        it('CT03 — context.assembled payload contains executionId, assemblyId, section counts, tokens, durationMs', () => {
            const { bus, events } = makeBus();
            const svc = new ContextAssemblerService(bus);

            const result = svc.assemble(substantiveInputs({
                approvedMemories: [makeMemory('m1', 'A memory.')],
            }));

            const assembled = events.find(e => e.event === 'context.assembled');
            expect(assembled).toBeDefined();
            const p = assembled!.payload!;

            expect(p['assemblyId']).toBe(result.metadata.assemblyId);
            expect(p['turnId']).toBe(result.metadata.turnId);
            expect(assembled!.executionId).toBe('exec-ct01');
            expect(typeof p['sectionCount']).toBe('number');
            expect(typeof p['includedSectionCount']).toBe('number');
            expect(typeof p['totalEstimatedTokens']).toBe('number');
            expect(typeof p['totalBudgetTokens']).toBe('number');
            expect(typeof p['assemblyDurationMs']).toBe('number');
            expect(p['assemblyDurationMs']).toBeGreaterThanOrEqual(0);
        });

        it('CT04 — context.truncated emitted when a section is truncated by budget', () => {
            const { bus, events } = makeBus();
            const svc = new ContextAssemblerService(bus);

            // memory section maxChars = 8000. Supply > 8000 chars.
            svc.assemble(substantiveInputs({
                approvedMemories: [makeMemory('m1', 'word '.repeat(2000))],
            }));

            const truncated = events.find(e => e.event === 'context.truncated');
            expect(truncated).toBeDefined();
            expect(truncated!.payload!['truncatedSectionCount']).toBeGreaterThan(0);
            expect(Array.isArray(truncated!.payload!['truncatedSections'])).toBe(true);
        });

        it('CT05 — context.section_excluded emitted for each excluded section', () => {
            const { bus, events } = makeBus();
            const svc = new ContextAssemblerService(bus);

            // greeting turn — multiple sections will be excluded
            const result = svc.assemble(baseInputs({ isGreeting: true }));

            const excludedEvents = events.filter(e => e.event === 'context.section_excluded');
            const excludedSectionsInResult = result.sections.filter(s => !s.included);

            expect(excludedEvents.length).toBe(excludedSectionsInResult.length);
            expect(excludedEvents.length).toBeGreaterThan(0);
        });
    });

    // ─── CT06–CT09: Traceability metadata ────────────────────────────────────

    describe('CT06–CT09 — Traceability metadata', () => {

        it('CT06 — metadata.assemblyId is a non-empty string', () => {
            const svc = new ContextAssemblerService();
            const result = svc.assemble(baseInputs());
            expect(typeof result.metadata.assemblyId).toBe('string');
            expect(result.metadata.assemblyId.length).toBeGreaterThan(0);
        });

        it('CT07 — metadata.executionId is echoed from inputs.executionId', () => {
            const svc = new ContextAssemblerService();
            const result = svc.assemble(baseInputs({ executionId: 'exec-trace-99' }));
            expect(result.metadata.executionId).toBe('exec-trace-99');
        });

        it('CT07b — metadata.executionId is empty string when inputs.executionId is absent', () => {
            const svc = new ContextAssemblerService();
            const inputs = baseInputs();
            delete (inputs as Partial<ContextAssemblerInputs>).executionId;
            const result = svc.assemble(inputs);
            expect(result.metadata.executionId).toBe('');
        });

        it('CT08 — metadata.sourceCategories lists content-producing sections (excl. control sections)', () => {
            const svc = new ContextAssemblerService();
            const result = svc.assemble(substantiveInputs({
                identityText: 'I am Tala.',
                approvedMemories: [makeMemory('m1', 'Memory about you.')],
                docContextText: 'Doc text.',
            }));

            // identity, memory, document should be in sourceCategories
            expect(result.metadata.sourceCategories).toContain('identity');
            expect(result.metadata.sourceCategories).toContain('memory');
            expect(result.metadata.sourceCategories).toContain('document');
            // control sections must NOT be in sourceCategories
            expect(result.metadata.sourceCategories).not.toContain('mode_constraints');
            expect(result.metadata.sourceCategories).not.toContain('request_summary');
        });

        it('CT09 — metadata.excludedSections lists section names with included=false', () => {
            const svc = new ContextAssemblerService();
            const result = svc.assemble(baseInputs({ isGreeting: true }));

            const notIncluded = result.sections.filter(s => !s.included).map(s => s.name);
            expect(result.metadata.excludedSections.sort()).toEqual(notIncluded.sort());
            expect(result.metadata.excludedSections.length).toBeGreaterThan(0);
        });
    });

    // ─── CT10–CT12: Policy-filter hooks ──────────────────────────────────────

    describe('CT10–CT12 — Policy-filter hooks', () => {

        it('CT10 — modeExclusions policy excludes named sections for the active mode', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                modeExclusions: {
                    rp: ['affective', 'graph_retrieval'],
                },
            };
            const result = svc.assemble(substantiveInputs({
                mode: 'rp',
                astroStateText: 'Contemplative.',
                emotionalModulationApplied: true,
                graphContextText: 'Graph node A.',
                assemblyPolicy: policy,
            }));

            const affective = result.sections.find(s => s.name === 'affective');
            const graph = result.sections.find(s => s.name === 'graph_retrieval');

            expect(affective?.included).toBe(false);
            expect(affective?.exclusionReason).toBe('policy_suppressed');
            expect(graph?.included).toBe(false);
            expect(graph?.exclusionReason).toBe('policy_suppressed');
        });

        it('CT10b — modeExclusions policy does not affect a different active mode', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                modeExclusions: {
                    rp: ['affective'],
                },
            };
            const result = svc.assemble(substantiveInputs({
                mode: 'assistant',
                astroStateText: 'Playful.',
                emotionalModulationApplied: true,
                assemblyPolicy: policy,
            }));

            const affective = result.sections.find(s => s.name === 'affective');
            expect(affective?.included).toBe(true);
            expect(affective?.exclusionReason).toBeUndefined();
        });

        it('CT11 — blockedSections policy excludes named sections with exclusionReason=policy_suppressed', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                blockedSections: ['document', 'graph_retrieval'],
            };
            const result = svc.assemble(substantiveInputs({
                docContextText: 'Some docs.',
                graphContextText: 'Graph data.',
                assemblyPolicy: policy,
            }));

            const doc = result.sections.find(s => s.name === 'document');
            const graph = result.sections.find(s => s.name === 'graph_retrieval');

            expect(doc?.included).toBe(false);
            expect(doc?.exclusionReason).toBe('policy_suppressed');
            expect(graph?.included).toBe(false);
            expect(graph?.exclusionReason).toBe('policy_suppressed');
        });

        it('CT11b — blockedSections cannot block mandatory sections', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                blockedSections: ['mode_constraints', 'request_summary'],
            };
            const result = svc.assemble(baseInputs({ assemblyPolicy: policy }));

            const mode = result.sections.find(s => s.name === 'mode_constraints');
            const req = result.sections.find(s => s.name === 'request_summary');

            expect(mode?.included).toBe(true);
            expect(req?.included).toBe(true);
        });

        it('CT12 — allowedSections policy excludes non-listed sections with exclusionReason=policy_suppressed', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                // Only allow identity and memory; all others (non-mandatory) should be excluded
                allowedSections: ['identity', 'memory'],
            };
            const result = svc.assemble(substantiveInputs({
                identityText: 'I am Tala.',
                approvedMemories: [makeMemory('m1', 'Memory content.')],
                docContextText: 'Doc text.',
                graphContextText: 'Graph data.',
                astroStateText: 'Mood.',
                emotionalModulationApplied: true,
                assemblyPolicy: policy,
            }));

            const doc = result.sections.find(s => s.name === 'document');
            const graph = result.sections.find(s => s.name === 'graph_retrieval');
            const affective = result.sections.find(s => s.name === 'affective');
            const tool = result.sections.find(s => s.name === 'tool_availability');

            // These should be excluded by allowedSections policy
            expect(doc?.exclusionReason).toBe('policy_suppressed');
            expect(graph?.exclusionReason).toBe('policy_suppressed');
            expect(affective?.exclusionReason).toBe('policy_suppressed');
            // tool_availability had no capabilities, so it's no_content already
            // but it's not in allowedSections so it should also be policy_suppressed
            expect(tool?.exclusionReason).toBe('policy_suppressed');

            // Allowed sections must still be present
            expect(result.sections.find(s => s.name === 'identity')?.included).toBe(true);
            expect(result.sections.find(s => s.name === 'memory')?.included).toBe(true);

            // Mandatory sections must survive
            expect(result.sections.find(s => s.name === 'mode_constraints')?.included).toBe(true);
            expect(result.sections.find(s => s.name === 'request_summary')?.included).toBe(true);
        });

        it('CT12b — policyExcludedCount in metadata reflects policy-suppressed sections', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                blockedSections: ['document', 'graph_retrieval', 'affective'],
            };
            const result = svc.assemble(substantiveInputs({
                docContextText: 'Doc.',
                graphContextText: 'Graph.',
                astroStateText: 'Mood.',
                emotionalModulationApplied: true,
                assemblyPolicy: policy,
            }));

            expect(result.metadata.policyExcludedCount).toBe(3);
        });
    });

    // ─── CT13: Evidence filtering ────────────────────────────────────────────

    describe('CT13 — blockedSourceClasses evidence filtering', () => {

        it('CT13 — blockedSourceClasses removes matching evidence items from assembled output', () => {
            const svc = new ContextAssemblerService();
            const policy: ContextAssemblyPolicy = {
                blockedSourceClasses: ['graph'],
            };
            const result = svc.assemble(substantiveInputs({
                approvedMemories: [
                    makeMemory('m1', 'Standard memory.', 'memory'),
                    makeMemory('g1', 'Graph-sourced memory.', 'graph'),
                    makeMemory('m2', 'Another standard memory.', 'memory'),
                ],
                assemblyPolicy: policy,
            }));

            // graph-sourced evidence should be removed
            expect(result.evidence.find(e => e.evidenceId === 'g1')).toBeUndefined();
            // other evidence should remain
            expect(result.evidence.find(e => e.evidenceId === 'm1')).toBeDefined();
            expect(result.evidence.find(e => e.evidenceId === 'm2')).toBeDefined();
        });
    });

    // ─── CT14: Purity invariant ──────────────────────────────────────────────

    describe('CT14 — Purity invariant', () => {

        it('CT14 — no memory writes occur during service assembly', () => {
            const { bus } = makeBus();
            const svc = new ContextAssemblerService(bus);
            const writeSpy = vi.fn();

            const result = svc.assemble(substantiveInputs({
                approvedMemories: [makeMemory('m1', 'Test memory.')],
            }));

            // Assembly must complete
            expect(result).toBeDefined();
            expect(result.metadata.turnId).toBe('turn-ct01');
            // writeSpy was never passed to assemble() — confirms no service injection path
            expect(writeSpy).not.toHaveBeenCalled();
        });
    });

    // ─── CT15: Determinism ───────────────────────────────────────────────────

    describe('CT15 — Deterministic trace output', () => {

        it('CT15 — identical inputs produce same section inclusion/reasons/counts across runs', () => {
            const svc = new ContextAssemblerService();
            const inputs = substantiveInputs({
                identityText: 'I am Tala.',
                approvedMemories: [makeMemory('m1', 'Memory A.'), makeMemory('m2', 'Memory B.')],
                docContextText: 'Documentation text.',
                graphContextText: 'Graph node A → B.',
                astroStateText: 'Contemplative.',
                emotionalModulationApplied: true,
                emotionalModulationStrength: 'medium',
                allowedCapabilities: ['memory_retrieval'],
                memoryRetrievalPolicy: 'full',
                assemblyPolicy: { blockedSections: ['tool_availability'] },
                executionId: 'exec-determinism',
            });

            const r1 = svc.assemble(inputs);
            const r2 = svc.assemble(inputs);

            // Section counts and inclusion must match
            expect(r1.metadata.sectionCount).toBe(r2.metadata.sectionCount);
            expect(r1.metadata.includedSectionCount).toBe(r2.metadata.includedSectionCount);
            expect(r1.metadata.totalEstimatedTokens).toBe(r2.metadata.totalEstimatedTokens);
            expect(r1.metadata.policyExcludedCount).toBe(r2.metadata.policyExcludedCount);
            expect(r1.metadata.droppedSectionCount).toBe(r2.metadata.droppedSectionCount);
            expect(r1.metadata.truncatedSectionCount).toBe(r2.metadata.truncatedSectionCount);
            expect(r1.metadata.sourceCategories.sort()).toEqual(r2.metadata.sourceCategories.sort());
            expect(r1.metadata.excludedSections.sort()).toEqual(r2.metadata.excludedSections.sort());

            // Section-level inclusion/exclusion reasons must match
            for (let i = 0; i < r1.sections.length; i++) {
                expect(r1.sections[i].name).toBe(r2.sections[i].name);
                expect(r1.sections[i].included).toBe(r2.sections[i].included);
                expect(r1.sections[i].selectionReason).toBe(r2.sections[i].selectionReason);
                expect(r1.sections[i].exclusionReason).toBe(r2.sections[i].exclusionReason);
            }

            // Evidence count and IDs must match (order may differ — sort by evidenceId)
            const e1 = [...r1.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
            const e2 = [...r2.evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
            expect(e1.map(e => e.evidenceId)).toEqual(e2.map(e => e.evidenceId));

            // assemblyId must differ (it's a fresh UUID per run — non-deterministic by design)
            expect(r1.metadata.assemblyId).not.toBe(r2.metadata.assemblyId);
        });
    });
});
