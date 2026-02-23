import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ArtifactStore } from '../../electron/services/reflection/ArtifactStore';
import type { ReflectionEvent, ChangeProposal, OutcomeRecord, RiskScore } from '../../electron/services/reflection/types';

/**
 * ArtifactStore Tests
 * 
 * Validates persistence of reflections, proposals, and outcomes
 * as well as index management, purge, and rebuild operations.
 */

let testDir: string;
let store: ArtifactStore;

function makeReflectionEvent(id: string): ReflectionEvent {
    return {
        id,
        timestamp: new Date().toISOString(),
        summary: `Test reflection ${id}`,
        evidence: { turns: [], errors: ['test error'], failedToolCalls: [] },
        observations: ['Test observation'],
        metrics: { averageLatencyMs: 100, errorRate: 0.1 }
    };
}

function makeProposal(id: string, reflectionId: string): ChangeProposal {
    return {
        id,
        reflectionId,
        category: 'bugfix',
        title: `Test proposal ${id}`,
        description: 'A test proposal for validation',
        risk: { score: 3 as RiskScore, reasoning: 'Low risk test' },
        changes: [{ type: 'patch', path: 'test.ts', search: 'old', replace: 'new' }],
        rollbackPlan: 'Revert test.ts',
        status: 'pending'
    };
}

function makeOutcome(proposalId: string): OutcomeRecord {
    return {
        proposalId,
        timestamp: new Date().toISOString(),
        success: true,
        testResults: [{ testName: 'Smoke', passed: true }],
        rollbackPerformed: false
    };
}

describe('ArtifactStore', () => {
    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-test-'));
        store = new ArtifactStore(testDir);
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('creates required directories on init', () => {
        const memDir = path.join(testDir, 'memory');
        expect(fs.existsSync(path.join(memDir, 'reflections'))).toBe(true);
        expect(fs.existsSync(path.join(memDir, 'proposals'))).toBe(true);
        expect(fs.existsSync(path.join(memDir, 'outcomes'))).toBe(true);
        expect(fs.existsSync(path.join(memDir, 'backups', 'reflection_changes'))).toBe(true);
    });

    it('saves and retrieves a reflection event', async () => {
        const event = makeReflectionEvent('ref-001');
        await store.saveReflection(event);

        const filePath = path.join(testDir, 'memory', 'reflections', 'ref-001.json');
        expect(fs.existsSync(filePath)).toBe(true);

        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(saved.id).toBe('ref-001');
        expect(saved.summary).toContain('Test reflection');
    });

    it('saves and retrieves proposals', async () => {
        const proposal = makeProposal('prop-001', 'ref-001');
        await store.saveProposal(proposal);

        const all = await store.getProposals();
        expect(all.length).toBe(1);
        expect(all[0].id).toBe('prop-001');
        expect(all[0].status).toBe('pending');
    });

    it('filters proposals by status', async () => {
        const p1 = makeProposal('p1', 'ref-001');
        const p2 = makeProposal('p2', 'ref-001');
        p2.status = 'applied';

        await store.saveProposal(p1);
        await store.saveProposal(p2);

        const pending = await store.getProposals('pending');
        expect(pending.length).toBe(1);
        expect(pending[0].id).toBe('p1');

        const applied = await store.getProposals('applied');
        expect(applied.length).toBe(1);
        expect(applied[0].id).toBe('p2');
    });

    it('saves and retrieves outcomes', async () => {
        const outcome = makeOutcome('prop-001');
        await store.saveOutcome(outcome);

        const outcomes = store.getOutcomes();
        expect(outcomes.length).toBe(1);
        expect(outcomes[0].success).toBe(true);
    });

    it('counts reflections and proposals', async () => {
        await store.saveReflection(makeReflectionEvent('r1'));
        await store.saveReflection(makeReflectionEvent('r2'));
        await store.saveProposal(makeProposal('p1', 'r1'));

        expect(store.getReflectionCount()).toBe(2);
        expect(store.getProposalCount()).toBe(1);
    });

    it('purges old records by file age', async () => {
        const proposal = makeProposal('old-prop', 'old-ref');
        await store.saveProposal(proposal);

        // Artificially age the file (set mtime to 100 days ago)
        const filePath = path.join(testDir, 'memory', 'proposals', 'old-prop.json');
        const pastDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
        fs.utimesSync(filePath, pastDate, pastDate);

        // Also save a fresh one
        await store.saveProposal(makeProposal('new-prop', 'new-ref'));

        // Purge records older than 30 days
        await store.purgeOldRecords(30);

        expect(store.getProposalCount()).toBe(1); // Only the new one remains
        const remaining = await store.getProposals();
        expect(remaining[0].id).toBe('new-prop');
    });

    it('updates the reflection index on save', async () => {
        await store.saveReflection(makeReflectionEvent('r1'));
        await store.saveProposal(makeProposal('p1', 'r1'));

        const indexPath = path.join(testDir, 'memory', 'reflection_index.json');
        expect(fs.existsSync(indexPath)).toBe(true);

        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        expect(index.reflections.length).toBe(1);
        expect(index.proposals.length).toBe(1);
    });
});
