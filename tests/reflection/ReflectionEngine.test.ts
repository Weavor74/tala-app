import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReflectionEngine, TurnRecord } from '../../electron/services/reflection/ReflectionEngine';
import { ArtifactStore } from '../../electron/services/reflection/ArtifactStore';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * ReflectionEngine Tests
 * 
 * Validates evidence collection, turn tracking, latency computation,
 * and observation generation.
 */

let testDir: string;
let store: ArtifactStore;
let engine: ReflectionEngine;

describe('ReflectionEngine', () => {
    beforeEach(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-refl-'));
        store = new ArtifactStore(testDir);
        engine = new ReflectionEngine(store);

        // Drain any leftover static buffers from previous tests
        await engine.runCycle();
    });

    describe('Turn Tracking', () => {
        it('records and retrieves latency stats', () => {
            // Record some turns
            ReflectionEngine.recordTurn({
                timestamp: new Date().toISOString(),
                latencyMs: 1000,
                turnNumber: 1,
                model: 'llama3',
                tokensUsed: 500,
                hadToolCalls: false
            });
            ReflectionEngine.recordTurn({
                timestamp: new Date().toISOString(),
                latencyMs: 3000,
                turnNumber: 2,
                model: 'llama3',
                tokensUsed: 800,
                hadToolCalls: true
            });
            ReflectionEngine.recordTurn({
                timestamp: new Date().toISOString(),
                latencyMs: 2000,
                turnNumber: 3,
                model: 'llama3',
                tokensUsed: 600,
                hadToolCalls: false
            });

            const stats = ReflectionEngine.getLatencyStats();
            expect(stats.count).toBe(3);
            expect(stats.avgMs).toBe(2000); // (1000 + 3000 + 2000) / 3
            expect(stats.maxMs).toBe(3000);
            expect(stats.p95Ms).toBeGreaterThanOrEqual(2000);
        });

        it('returns zero stats when no turns recorded', () => {
            // Buffers were drained in beforeEach, so stats should be empty
            const stats = ReflectionEngine.getLatencyStats();
            expect(stats.count).toBe(0);
            expect(stats.avgMs).toBe(0);
        });
    });

    describe('Tool Failure Reporting', () => {
        it('captures reported tool failures', () => {
            ReflectionEngine.reportToolFailure('browse', 'Timeout waiting for DOM');
            ReflectionEngine.reportToolFailure('terminal_run', 'Command not found');

            // These will be collected in the next reflection cycle
            // We can verify by running a cycle
        });
    });

    describe('Reflection Cycle', () => {
        it('returns null when system is healthy (no evidence)', async () => {
            const event = await engine.runCycle();
            expect(event).toBeNull();
        });

        it('produces a reflection event when errors exist', async () => {
            // Inject errors via console.error
            console.error('[Test] Simulated inference timeout');
            console.error('[Test] ECONNREFUSED from Ollama');

            const event = await engine.runCycle();
            expect(event).not.toBeNull();
            expect(event!.evidence.errors.length).toBeGreaterThan(0);
            expect(event!.summary).toContain('error');
        });

        it('includes turn data in reflection events', async () => {
            // Record turns then run a cycle
            ReflectionEngine.recordTurn({
                timestamp: new Date().toISOString(),
                latencyMs: 5000,
                turnNumber: 1,
                model: 'gpt-4',
                tokensUsed: 1200,
                hadToolCalls: true
            });

            // Need at least one error to trigger a non-null event
            console.error('[Test] Tool call failed: search_web');

            const event = await engine.runCycle();
            expect(event).not.toBeNull();
            expect(event!.evidence.turns.length).toBe(1);
            expect(event!.evidence.turns[0].latencyMs).toBe(5000);
            expect(event!.metrics.averageLatencyMs).toBe(5000);
        });

        it('drains buffers after collection (no double-counting)', async () => {
            console.error('[Test] Intentional test error');

            const event1 = await engine.runCycle();
            expect(event1).not.toBeNull();

            // Second cycle should be clean
            const event2 = await engine.runCycle();
            expect(event2).toBeNull();
        });

        it('generates meaningful observations for timeout errors', async () => {
            console.error('Request timed out after 30000ms');
            console.error('Connection timed out to Ollama');

            const event = await engine.runCycle();
            expect(event).not.toBeNull();

            const hasTimeoutObs = event!.observations.some(o => o.includes('timeout'));
            expect(hasTimeoutObs).toBe(true);
        });
    });

    // Clean up temp dir
    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });
});
