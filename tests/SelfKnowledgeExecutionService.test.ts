import { describe, expect, it } from 'vitest';
import { SelfKnowledgeExecutionService } from '../electron/services/agent/SelfKnowledgeExecutionService';

describe('SelfKnowledgeExecutionService', () => {
    it('builds snapshot from self-model, tool registry, turn policy, and diagnostics', async () => {
        const service = new SelfKnowledgeExecutionService();
        const result = await service.executeSelfKnowledgeTurn({
            text: 'What can you do?',
            mode: 'rp',
            allowWritesThisTurn: false,
            toolsAllowedThisTurn: true,
            toolRegistry: {
                getAllTools: () => ([
                    { name: 'fs_read_text', source: 'filesystem', description: 'read files' },
                    { name: 'mem0_search', source: 'memory', description: 'memory search' },
                ]),
            },
            selfModelService: {
                queryCapabilities: () => ({
                    capabilities: [
                        { id: 'memory.read.canonical' },
                        { id: 'memory.write.canonical' },
                    ],
                }),
                queryInvariants: () => ({
                    invariants: [{ id: 'inv-1', statement: 'Canonical memory authority' }],
                }),
                getArchitectureSummary: () => ({
                    totalComponents: 12,
                    totalCapabilities: 8,
                    availableCapabilities: 7,
                    totalInvariants: 6,
                    activeInvariants: 5,
                }),
            },
            runtimeDiagnostics: {
                getSnapshot: () => ({
                    systemHealth: {
                        active_degradation_flags: ['memory_degraded'],
                        capability_matrix: [
                            { capability: 'memory_canonical_read', status: 'degraded' },
                            { capability: 'tool_execute_read', status: 'available' },
                        ],
                    },
                    degradedSubsystems: ['graph_service_unavailable'],
                }),
            },
            filesystemPolicy: {
                getAllowedRoot: () => 'D:/src/client1/tala-app',
                getWritePolicy: () => 'writes_blocked_this_turn',
            },
        });

        expect(result.executed).toBe(true);
        expect(result.sourceTruths).toEqual(
            expect.arrayContaining(['self_model', 'tool_registry', 'runtime_diagnostics', 'filesystem_policy']),
        );
        expect(result.snapshot.currentTurn.writesAllowed).toBe(false);
        expect(result.snapshot.currentTurn.toolsAllowed).toBe(true);
        expect(result.snapshot.runtime.degradedReasons).toEqual(
            expect.arrayContaining(['memory_degraded', 'graph_service_unavailable']),
        );
        expect(result.summary).toContain('I am Tala, a local agent running inside the Tala app runtime.');
        expect(result.summary).toContain('Capabilities:');
        expect(result.summary).toContain('Current turn:');
    });

    it('does not fabricate capabilities when sources are absent', async () => {
        const service = new SelfKnowledgeExecutionService();
        const result = await service.executeSelfKnowledgeTurn({
            text: 'Do you have memory?',
            allowWritesThisTurn: false,
            toolsAllowedThisTurn: false,
            toolRegistry: { getAllTools: () => [] },
        });

        expect(result.executed).toBe(true);
        expect(result.sourceTruths).toEqual([]);
        expect(result.snapshot.capabilities.toolUsage).toBe(false);
        expect(result.snapshot.capabilities.memoryRead).toBe(false);
        expect(result.snapshot.capabilities.memoryWrite).toBe(false);
        expect(result.snapshot.currentTurn.writesAllowed).toBe(false);
        expect(result.snapshot.currentTurn.toolsAllowed).toBe(false);
    });

    it('narrows summary for specific aspect requests', async () => {
        const service = new SelfKnowledgeExecutionService();
        const result = await service.executeSelfKnowledgeTurn({
            text: 'What tools do you have?',
            allowWritesThisTurn: true,
            toolsAllowedThisTurn: true,
            toolRegistry: {
                getAllTools: () => ([
                    { name: 'fs_read_text', source: 'filesystem' },
                    { name: 'mem0_search', source: 'memory' },
                ]),
            },
        });

        expect(result.executed).toBe(true);
        expect(result.summary).toContain('Tools: fs_read_text, mem0_search.');
        expect(result.summary).not.toContain('Current turn:');
    });
});

