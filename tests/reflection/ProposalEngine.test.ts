import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProposalEngine } from '../../electron/services/reflection/ProposalEngine';
import type { ReflectionEvent, RiskScore } from '../../electron/services/reflection/types';

/**
 * ProposalEngine Tests
 * 
 * Tests heuristic proposal generation (LLM tests require a running inference server).
 */

function makeEvent(overrides: Partial<ReflectionEvent> = {}): ReflectionEvent {
    return {
        id: 'evt-001',
        timestamp: new Date().toISOString(),
        summary: 'Test event',
        evidence: {
            turns: [],
            errors: [],
            failedToolCalls: []
        },
        observations: [],
        metrics: { averageLatencyMs: 0, errorRate: 0 },
        ...overrides
    };
}

describe('ProposalEngine', () => {
    let engine: ProposalEngine;

    beforeEach(() => {
        // No settingsPath = heuristic-only mode
        engine = new ProposalEngine();
    });

    it('generates no proposals for clean events', async () => {
        const event = makeEvent();
        const proposals = await engine.generateProposals(event);
        expect(proposals.length).toBe(0);
    });

    it('generates timeout proposals when timeout errors detected', async () => {
        const event = makeEvent({
            evidence: {
                turns: [],
                errors: [
                    'Request timed out after 30000ms',
                    'Connection timed out to Ollama',
                    'Read timeout on inference call'
                ],
                failedToolCalls: []
            },
            observations: ['3 timeout errors detected']
        });

        const proposals = await engine.generateProposals(event);
        expect(proposals.length).toBeGreaterThanOrEqual(1);
        expect(proposals[0].category).toBe('bugfix');
        expect(proposals[0].title.toLowerCase()).toContain('timeout');
    });

    it('generates tool hardening proposals for repeated failures', async () => {
        const event = makeEvent({
            evidence: {
                turns: [],
                errors: [],
                failedToolCalls: [
                    { tool: 'browse', error: 'Timeout' },
                    { tool: 'browse', error: 'No DOM' },
                    { tool: 'browse', error: 'Connection lost' },
                    { tool: 'terminal_run', error: 'Command not found' }
                ]
            }
        });

        const proposals = await engine.generateProposals(event);
        expect(proposals.length).toBeGreaterThanOrEqual(1);

        const hardenProposal = proposals.find(p => p.title.toLowerCase().includes('harden') || p.title.toLowerCase().includes('error'));
        expect(hardenProposal).toBeDefined();
    });

    it('generates inference fallback proposal for connection errors', async () => {
        const event = makeEvent({
            evidence: {
                turns: [],
                errors: [
                    'ECONNREFUSED connecting to Ollama',
                    'fetch failed: ECONNRESET'
                ],
                failedToolCalls: []
            }
        });

        const proposals = await engine.generateProposals(event);
        const fallbackProposal = proposals.find(p => p.title.toLowerCase().includes('fallback'));
        expect(fallbackProposal).toBeDefined();
        expect(fallbackProposal!.category).toBe('workflow');
    });

    it('generates high error rate advisory', async () => {
        const event = makeEvent({
            metrics: { averageLatencyMs: 500, errorRate: 0.75 }
        });

        const proposals = await engine.generateProposals(event);
        const advisory = proposals.find(p => p.title.toLowerCase().includes('error rate'));
        expect(advisory).toBeDefined();
        expect(advisory!.risk.score).toBeLessThanOrEqual(3);
    });

    it('generates latency advisory for slow inference', async () => {
        const event = makeEvent({
            evidence: {
                turns: [{ latencyMs: 20000, turnNumber: 1 }],
                errors: ['slow'],
                failedToolCalls: []
            },
            metrics: { averageLatencyMs: 20000, errorRate: 0 }
        });

        const proposals = await engine.generateProposals(event);
        const latencyProposal = proposals.find(p => p.title.toLowerCase().includes('latency'));
        expect(latencyProposal).toBeDefined();
    });

    it('caps proposals at 3 per cycle', async () => {
        const event = makeEvent({
            evidence: {
                turns: [],
                errors: [
                    'timeout error 1', 'timeout error 2',
                    'ECONNREFUSED error 1', 'ECONNREFUSED error 2'
                ],
                failedToolCalls: [
                    { tool: 'a', error: 'fail' },
                    { tool: 'b', error: 'fail' },
                    { tool: 'c', error: 'fail' }
                ]
            },
            metrics: { averageLatencyMs: 25000, errorRate: 0.8 }
        });

        const proposals = await engine.generateProposals(event);
        expect(proposals.length).toBeLessThanOrEqual(3);
    });

    it('assigns valid proposal structure', async () => {
        const event = makeEvent({
            evidence: {
                turns: [],
                errors: ['timeout 1', 'timeout 2'],
                failedToolCalls: []
            }
        });

        const proposals = await engine.generateProposals(event);
        if (proposals.length > 0) {
            const p = proposals[0];
            expect(p.id).toBeTruthy();
            expect(p.reflectionId).toBe('evt-001');
            expect(p.status).toBe('pending');
            expect(typeof p.title).toBe('string');
            expect(typeof p.description).toBe('string');
            expect(typeof p.risk.score).toBe('number');
            expect(p.risk.score).toBeGreaterThanOrEqual(1);
            expect(p.risk.score).toBeLessThanOrEqual(10);
        }
    });
});
