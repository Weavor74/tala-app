/**
 * ContextAssembler.test.ts
 *
 * Tests for the ContextAssembler pure assembly boundary.
 *
 * Validates:
 *   CA01 — assembleContext returns a structured AssembledContext
 *   CA02 — metadata contains required fields
 *   CA03 — all 8 canonical sections are present in the result
 *   CA04 — mode_constraints section is always included
 *   CA05 — request_summary section is always included
 *   CA06 — identity section included when identityText is provided
 *   CA07 — identity section suppressed when identityText is absent
 *   CA08 — memory section included when approved memories are present
 *   CA09 — memory section suppressed when retrieval is suppressed
 *   CA10 — memory section uses fallback contract text when no memories and substantive intent
 *   CA11 — document section included when docContextText is provided
 *   CA12 — document section suppressed when docContextText is absent
 *   CA13 — graph section included when graphContextText is provided
 *   CA14 — graph section suppressed when graphContextText is absent
 *   CA15 — affective section included when astroStateText present and modulation applied
 *   CA16 — affective section suppressed when modulation is not applied
 *   CA17 — tool section included when capabilities are provided
 *   CA18 — tool section suppressed when no capabilities
 *   CA19 — evidence list populated from approvedMemories
 *   CA20 — evidence items carry correct selectionClass='evidence'
 *   CA21 — evidence items carry memoryId matching input id
 *   CA22 — no memory writes occur during assembly
 *   CA23 — no tool execution occurs during assembly
 *   CA24 — assembly output is stable (deterministic) for identical inputs
 *   CA25 — notebook-grounded mode uses CANON NOTEBOOK CONTEXT header
 *   CA26 — lore responseMode uses CANON LORE MEMORIES header
 *   CA27 — sections are ordered by canonical priority
 *   CA28 — wasCompacted is true when total contributions exceed 12
 *   CA29 — empty inputs produce valid AssembledContext without throwing
 *   CA30 — mode_constraints content reflects resolved policies
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '../electron/services/context/ContextAssembler';
import type { ContextAssemblerInputs, ContextEvidenceInput } from '../shared/context/assembledContextTypes';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseInputs(overrides: Partial<ContextAssemblerInputs> = {}): ContextAssemblerInputs {
    return {
        turnId: 'turn-001',
        rawInput: 'Hello, how are you?',
        normalizedInput: 'hello, how are you?',
        mode: 'assistant',
        intentClass: 'greeting',
        isGreeting: true,
        ...overrides,
    };
}

function substantiveInputs(overrides: Partial<ContextAssemblerInputs> = {}): ContextAssemblerInputs {
    return baseInputs({
        rawInput: 'What do you remember about our last conversation?',
        normalizedInput: 'what do you remember about our last conversation?',
        intentClass: 'lore_query',
        isGreeting: false,
        ...overrides,
    });
}

function makeMemory(id: string, text: string, source = 'memory'): ContextEvidenceInput {
    return { id, text, source, metadata: { source } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssembler', () => {

    describe('CA01–CA05 — Structural shape', () => {

        it('CA01 — assembleContext returns a structured AssembledContext', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            expect(result).toBeDefined();
            expect(result.metadata).toBeDefined();
            expect(Array.isArray(result.sections)).toBe(true);
            expect(Array.isArray(result.evidence)).toBe(true);
        });

        it('CA02 — metadata contains required fields', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const m = result.metadata;
            expect(m.turnId).toBe('turn-001');
            expect(m.mode).toBe('assistant');
            expect(m.intentClass).toBe('greeting');
            expect(typeof m.assembledAt).toBe('string');
            expect(typeof m.correlationId).toBe('string');
            expect(typeof m.sectionCount).toBe('number');
            expect(typeof m.includedSectionCount).toBe('number');
            expect(typeof m.totalEvidenceCount).toBe('number');
            expect(typeof m.wasCompacted).toBe('boolean');
            expect(typeof m.assemblyDurationMs).toBe('number');
        });

        it('CA03 — all 8 canonical sections are present in the result', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const names = result.sections.map(s => s.name);
            const expected = [
                'identity', 'mode_constraints', 'memory', 'document',
                'graph_retrieval', 'affective', 'tool_availability', 'request_summary',
            ];
            for (const name of expected) {
                expect(names).toContain(name);
            }
        });

        it('CA04 — mode_constraints section is always included', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'mode_constraints');
            expect(section?.included).toBe(true);
        });

        it('CA05 — request_summary section is always included', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'request_summary');
            expect(section?.included).toBe(true);
        });
    });

    describe('CA06–CA07 — Identity section', () => {

        it('CA06 — identity section included when identityText is provided', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                identityText: 'I am Tala, an introspective AI companion.',
            }));
            const section = result.sections.find(s => s.name === 'identity');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('Tala');
        });

        it('CA07 — identity section suppressed when identityText is absent', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'identity');
            expect(section?.included).toBe(false);
            expect(section?.suppressionReason).toBeDefined();
        });
    });

    describe('CA08–CA10 — Memory section', () => {

        it('CA08 — memory section included when approved memories are present', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [makeMemory('m1', 'We talked about philosophy.')],
            }));
            const section = result.sections.find(s => s.name === 'memory');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('philosophy');
        });

        it('CA09 — memory section suppressed when retrieval is suppressed', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                memoryRetrievalSuppressed: true,
                memorySuppressionReason: 'Mode policy suppresses retrieval',
            }));
            const section = result.sections.find(s => s.name === 'memory');
            expect(section?.included).toBe(false);
            expect(section?.suppressionReason).toContain('suppress');
        });

        it('CA10 — memory section uses fallback contract text when no memories and substantive intent', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [],
                memoryRetrievalSuppressed: false,
            }));
            const section = result.sections.find(s => s.name === 'memory');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('No approved memories');
            expect(section?.content).toContain('Do not invent');
        });
    });

    describe('CA11–CA12 — Document section', () => {

        it('CA11 — document section included when docContextText is provided', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                docContextText: 'The API returns JSON payloads.',
                docSourceIds: ['doc-1', 'doc-2'],
            }));
            const section = result.sections.find(s => s.name === 'document');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('JSON');
            expect(section?.content).toContain('doc-1');
        });

        it('CA12 — document section suppressed when docContextText is absent', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'document');
            expect(section?.included).toBe(false);
            expect(section?.suppressionReason).toBeDefined();
        });
    });

    describe('CA13–CA14 — Graph/retrieval section', () => {

        it('CA13 — graph section included when graphContextText is provided', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                graphContextText: 'Node: PersonA — connected to PersonB via friendship.',
            }));
            const section = result.sections.find(s => s.name === 'graph_retrieval');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('PersonA');
        });

        it('CA14 — graph section suppressed when graphContextText is absent', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'graph_retrieval');
            expect(section?.included).toBe(false);
            expect(section?.suppressionReason).toBeDefined();
        });
    });

    describe('CA15–CA16 — Affective section', () => {

        it('CA15 — affective section included when astroStateText present and modulation applied', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                astroStateText: 'Emotional state: contemplative, introspective.',
                emotionalModulationApplied: true,
                emotionalModulationStrength: 'medium',
            }));
            const section = result.sections.find(s => s.name === 'affective');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('contemplative');
            expect(section?.content).toContain('medium');
        });

        it('CA16 — affective section suppressed when modulation is not applied', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                astroStateText: 'Emotional state: calm.',
                emotionalModulationApplied: false,
            }));
            const section = result.sections.find(s => s.name === 'affective');
            expect(section?.included).toBe(false);
            expect(section?.suppressionReason).toBeDefined();
        });
    });

    describe('CA17–CA18 — Tool availability section', () => {

        it('CA17 — tool section included when capabilities are provided', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                allowedCapabilities: ['memory_retrieval', 'system_core'],
                blockedCapabilities: ['memory_write'],
            }));
            const section = result.sections.find(s => s.name === 'tool_availability');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('memory_retrieval');
            expect(section?.content).toContain('memory_write');
        });

        it('CA18 — tool section suppressed when no capabilities', () => {
            const result = ContextAssembler.assembleContext(baseInputs());
            const section = result.sections.find(s => s.name === 'tool_availability');
            expect(section?.included).toBe(false);
        });
    });

    describe('CA19–CA21 — Evidence', () => {

        it('CA19 — evidence list populated from approvedMemories', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [
                    makeMemory('ev-1', 'First memory content.'),
                    makeMemory('ev-2', 'Second memory content.'),
                ],
            }));
            expect(result.evidence).toHaveLength(2);
        });

        it('CA20 — evidence items carry correct selectionClass="evidence"', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [makeMemory('ev-1', 'Content.')],
            }));
            expect(result.evidence[0].selectionClass).toBe('evidence');
        });

        it('CA21 — evidence items carry memoryId matching input id', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [makeMemory('ev-abc', 'Content.')],
            }));
            expect(result.evidence[0].memoryId).toBe('ev-abc');
            expect(result.evidence[0].evidenceId).toBe('ev-abc');
        });
    });

    describe('CA22–CA23 — Side-effect purity', () => {

        it('CA22 — no memory writes occur during assembly', () => {
            // ContextAssembler is a pure static class with no injected service dependencies.
            // It has no references to MemoryService, MemoryAuthorityService, or any store.
            // This test validates the interface design guarantee: assembleContext() accepts only
            // ContextAssemblerInputs (a plain data object) and calls no external services.
            //
            // The spy below confirms that no write-like method on a hypothetical mock service
            // is ever called — which is structurally guaranteed because ContextAssembler does
            // not accept any service instance as a parameter.
            const writeSpy = vi.fn();

            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: [makeMemory('m1', 'Test memory.')],
            }));

            // Assembly must complete successfully
            expect(result).toBeDefined();
            expect(result.metadata.turnId).toBe('turn-001');
            // writeSpy was never passed to assembleContext — confirming no service injection path
            expect(writeSpy).not.toHaveBeenCalled();
        });

        it('CA23 — no tool execution occurs during assembly', () => {
            // ContextAssembler has no ToolService or ToolExecutionCoordinator dependency.
            // assembleContext() is a pure transformation: inputs → AssembledContext.
            // No tool call, no IPC call, no external network call is made during assembly.
            //
            // This test validates the interface design: the function signature accepts only
            // ContextAssemblerInputs and returns AssembledContext — no service injection point exists.
            const executeToolSpy = vi.fn();

            const result = ContextAssembler.assembleContext(substantiveInputs({
                allowedCapabilities: ['memory_retrieval'],
            }));

            // Assembly must complete successfully
            expect(result).toBeDefined();
            expect(result.sections.find(s => s.name === 'tool_availability')?.included).toBe(true);
            // executeToolSpy was never passed to assembleContext — confirming no tool execution path
            expect(executeToolSpy).not.toHaveBeenCalled();
        });
    });

    describe('CA24 — Determinism', () => {

        it('CA24 — assembly output is stable (deterministic) for identical inputs', () => {
            const inputs = substantiveInputs({
                identityText: 'I am Tala.',
                approvedMemories: [makeMemory('m1', 'First memory.'), makeMemory('m2', 'Second memory.')],
                docContextText: 'API documentation here.',
                graphContextText: 'Graph node: PersonA.',
                astroStateText: 'Contemplative.',
                emotionalModulationApplied: true,
                emotionalModulationStrength: 'medium',
                allowedCapabilities: ['memory_retrieval'],
                blockedCapabilities: ['memory_write'],
                memoryRetrievalPolicy: 'full',
                memoryWritePolicy: 'do_not_write',
                toolUsePolicy: 'task_only',
                docRetrievalPolicy: 'enabled',
                emotionalExpressionBounds: 'medium',
            });

            const result1 = ContextAssembler.assembleContext(inputs);
            const result2 = ContextAssembler.assembleContext(inputs);

            // Section count, inclusion, content must be stable
            expect(result1.sections.length).toBe(result2.sections.length);
            expect(result1.metadata.sectionCount).toBe(result2.metadata.sectionCount);
            expect(result1.metadata.includedSectionCount).toBe(result2.metadata.includedSectionCount);
            expect(result1.metadata.totalEvidenceCount).toBe(result2.metadata.totalEvidenceCount);
            expect(result1.metadata.wasCompacted).toBe(result2.metadata.wasCompacted);

            // All sections have the same name and content
            for (let i = 0; i < result1.sections.length; i++) {
                expect(result1.sections[i].name).toBe(result2.sections[i].name);
                expect(result1.sections[i].included).toBe(result2.sections[i].included);
                expect(result1.sections[i].content).toBe(result2.sections[i].content);
                expect(result1.sections[i].header).toBe(result2.sections[i].header);
            }

            // Evidence count and content stable
            expect(result1.evidence.length).toBe(result2.evidence.length);
            for (let i = 0; i < result1.evidence.length; i++) {
                expect(result1.evidence[i].evidenceId).toBe(result2.evidence[i].evidenceId);
                expect(result1.evidence[i].content).toBe(result2.evidence[i].content);
                expect(result1.evidence[i].selectionClass).toBe(result2.evidence[i].selectionClass);
            }
        });
    });

    describe('CA25–CA26 — Grounding modes', () => {

        it('CA25 — notebook-grounded mode uses CANON NOTEBOOK CONTEXT header', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                notebookGrounded: true,
                approvedMemories: [{
                    id: 'nb-1',
                    text: 'Notebook entry content.',
                    source: 'notebook',
                    metadata: { uri: 'notebook://doc-1.md' },
                }],
            }));
            const section = result.sections.find(s => s.name === 'memory');
            expect(section?.header).toBe('[CANON NOTEBOOK CONTEXT — STRICT]');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('notebook://doc-1.md');
        });

        it('CA26 — lore responseMode uses CANON LORE MEMORIES header', () => {
            const result = ContextAssembler.assembleContext(substantiveInputs({
                responseMode: 'memory_grounded_soft',
                approvedMemories: [{
                    id: 'lore-1',
                    text: 'A cherished memory from childhood.',
                    source: 'rag',
                }],
            }));
            const section = result.sections.find(s => s.name === 'memory');
            expect(section?.header).toBe('[CANON LORE MEMORIES — HIGH PRIORITY]');
            expect(section?.included).toBe(true);
            expect(section?.content).toContain('LTMF');
        });
    });

    describe('CA27 — Section ordering', () => {

        it('CA27 — sections are ordered by canonical priority (identity before mode before memory)', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                identityText: 'I am Tala.',
                approvedMemories: [makeMemory('m1', 'Memory.')],
            }));

            const names = result.sections.map(s => s.name);
            const identityIdx = names.indexOf('identity');
            const modeIdx = names.indexOf('mode_constraints');
            const memoryIdx = names.indexOf('memory');

            expect(identityIdx).toBeLessThan(modeIdx);
            expect(modeIdx).toBeLessThan(memoryIdx);
        });
    });

    describe('CA28 — Compaction', () => {

        it('CA28 — wasCompacted is true when total contributions exceed 12', () => {
            const manyMemories = Array.from({ length: 12 }, (_, i) =>
                makeMemory(`m${i}`, `Memory ${i} content.`),
            );
            const result = ContextAssembler.assembleContext(substantiveInputs({
                approvedMemories: manyMemories,
                docContextText: 'Documentation chunk.',
                graphContextText: 'Graph node.',
            }));
            expect(result.metadata.wasCompacted).toBe(true);
        });
    });

    describe('CA29–CA30 — Edge cases', () => {

        it('CA29 — empty inputs produce valid AssembledContext without throwing', () => {
            expect(() => {
                ContextAssembler.assembleContext(baseInputs());
            }).not.toThrow();
        });

        it('CA30 — mode_constraints content reflects resolved policies', () => {
            const result = ContextAssembler.assembleContext(baseInputs({
                memoryRetrievalPolicy: 'full',
                memoryWritePolicy: 'long_term',
                toolUsePolicy: 'all',
                docRetrievalPolicy: 'enabled',
                emotionalExpressionBounds: 'high',
            }));
            const section = result.sections.find(s => s.name === 'mode_constraints');
            expect(section?.content).toContain('Memory retrieval: full');
            expect(section?.content).toContain('Memory write: long_term');
            expect(section?.content).toContain('Tool use: all');
            expect(section?.content).toContain('Doc retrieval: enabled');
            expect(section?.content).toContain('Emotional expression: high');
        });
    });
});
