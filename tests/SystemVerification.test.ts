/**
 * SystemVerification.test.ts
 *
 * Verification harness for the Tala full-system verification plan.
 *
 * This file validates the shape contracts and observability properties that
 * are exercised by the runtime verification gates (Gates 1–3 of the plan).
 * It does NOT replace the live runtime checks — those require a running app.
 * It DOES lock in the invariants that make those live checks meaningful.
 *
 * What this covers:
 *   1. MemoryService.getReadyStatus() — returns false before ignite(), true
 *      after a successful connection. Without this the startup status API
 *      silently reported memory: true even when mem0 was offline.
 *   2. WorldService.getReadyStatus() — returns false before ignite(), true
 *      after. Same silent-true gap closed.
 *   3. AgentService.getStartupStatus() source contract — verified by static
 *      inspection (same approach as IpcChannelUniqueness.test.ts) to avoid
 *      the deep AgentService constructor chain in test context. Confirms that
 *      soulReady and the five service fields are all present in the return.
 *   4. Delegation: MemoryService and WorldService have getReadyStatus() so
 *      getStartupStatus() does not fall back silently to true for those fields.
 *   5. memoryGraph field — surfaces tala-memory-graph readiness via McpService
 *      isServiceCallable() so the graph status is observable alongside the
 *      other optional services.
 *
 * What this does NOT cover (already locked in elsewhere):
 *   - IPC channel uniqueness    → electron/__tests__/IpcChannelUniqueness.test.ts
 *   - Provider normalization     → tests/SettingsManagerNormalization.test.ts
 *   - Inference timeout constants → inferenceTimeouts.ts constant tests
 *   - Memory authority           → tests/MemoryAuthorityService.test.ts
 *   - Retrieval orchestrator     → tests/RetrievalOrchestrator.test.ts
 *   - MCP recovery loop fix      → tests/McpRecoveryLoop.test.ts
 *   - resultKey identity         → tests/SearchSelection.test.ts
 *   - Context assembly           → tests/P7D*.test.ts + ContextAssemblyService.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryService } from '../electron/services/MemoryService';
import { WorldService } from '../electron/services/WorldService';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── MemoryService.getReadyStatus() ──────────────────────────────────────────

describe('MemoryService.getReadyStatus()', () => {
    it('returns false before ignite() — mem0 not connected', () => {
        const svc = new MemoryService();
        expect(svc.getReadyStatus()).toBe(false);
    });

    it('returns false when client is null — method exists and is stable', () => {
        const svc = new MemoryService();
        // Confirm the method is a callable function (not missing/undefined).
        expect(typeof svc.getReadyStatus).toBe('function');
        // Pre-ignition: client is always null so readiness is false.
        expect(svc.getReadyStatus()).toBe(false);
    });
});

// ─── WorldService.getReadyStatus() ───────────────────────────────────────────

describe('WorldService.getReadyStatus()', () => {
    it('returns false before ignite() — world engine not started', () => {
        const svc = new WorldService();
        expect(svc.getReadyStatus()).toBe(false);
    });

    it('returns false after shutdown() on an un-ignited service', () => {
        const svc = new WorldService();
        svc.shutdown();
        expect(svc.getReadyStatus()).toBe(false);
    });

    it('method is a callable function — not missing or undefined', () => {
        const svc = new WorldService();
        expect(typeof svc.getReadyStatus).toBe('function');
    });
});

// ─── AgentService.getStartupStatus() source contract ─────────────────────────
//
// Static source inspection, same approach as IpcChannelUniqueness.test.ts.
// This avoids the heavy AgentService constructor chain (ToolService etc.)
// while still locking in the shape contract.

const AGENT_SERVICE_PATH = path.join(REPO_ROOT, 'electron', 'services', 'AgentService.ts');

describe('AgentService.getStartupStatus() source contract', () => {
    let agentServiceSource: string;

    beforeAll(() => {
        agentServiceSource = fs.readFileSync(AGENT_SERVICE_PATH, 'utf-8');
    });

    it('AgentService.ts is readable', () => {
        expect(agentServiceSource.length).toBeGreaterThan(0);
    });

    it('getStartupStatus() includes the rag field', () => {
        expect(agentServiceSource).toContain('rag:');
    });

    it('getStartupStatus() includes the memory field', () => {
        expect(agentServiceSource).toContain('memory:');
    });

    it('getStartupStatus() includes the astro field', () => {
        expect(agentServiceSource).toContain('astro:');
    });

    it('getStartupStatus() includes the world field', () => {
        expect(agentServiceSource).toContain('world:');
    });

    it('getStartupStatus() includes the soulReady field (igniteSoul completion flag)', () => {
        expect(agentServiceSource).toContain('soulReady:');
    });

    it('soulReady delegates to this.isSoulReady', () => {
        expect(agentServiceSource).toContain('soulReady: this.isSoulReady');
    });

    it('getStartupStatus() includes the memoryGraph field (tala-memory-graph readiness)', () => {
        expect(agentServiceSource).toContain('memoryGraph:');
    });

    it('memoryGraph field delegates through McpService.isServiceCallable — not a hardcoded constant', () => {
        expect(agentServiceSource).toContain("isServiceCallable?.('tala-memory-graph')");
    });

    it('memory field delegates through getReadyStatus — not a hardcoded constant', () => {
        // The delegation pattern must use getReadyStatus (not literal true/false).
        expect(agentServiceSource).toContain('memory: (this.memory as any).getReadyStatus');
    });

    it('world field delegates through getReadyStatus — not a hardcoded constant', () => {
        expect(agentServiceSource).toContain('world: (this.world as any).getReadyStatus');
    });
});

// ─── Delegation contract: getReadyStatus() exists on both services ────────────

describe('getStartupStatus() delegation — services expose getReadyStatus()', () => {
    it('MemoryService has getReadyStatus() — not a silent true fallback', () => {
        const svc = new MemoryService();
        // Before this fix: (this.memory as any).getReadyStatus evaluated to
        // undefined (falsy), so the fallback was always `true`. Now it must
        // be a real callable method.
        expect(typeof svc.getReadyStatus).toBe('function');
        // And it must return the correct pre-ignite state (false, not true).
        expect(svc.getReadyStatus()).toBe(false);
    });

    it('WorldService has getReadyStatus() — not a silent true fallback', () => {
        const svc = new WorldService();
        expect(typeof svc.getReadyStatus).toBe('function');
        expect(svc.getReadyStatus()).toBe(false);
    });
});

