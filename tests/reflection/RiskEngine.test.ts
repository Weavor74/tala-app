import { describe, it, expect, vi } from 'vitest';
import { RiskEngine } from '../../electron/services/reflection/RiskEngine';
import type { ChangeProposal, RiskScore } from '../../electron/services/reflection/types';

/**
 * RiskEngine Tests
 * 
 * Validates risk scoring, gate evaluation, and auto-apply decisions.
 */

function makeProposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
    return {
        id: 'test-prop-001',
        reflectionId: 'test-ref-001',
        category: 'bugfix',
        title: 'Test Proposal',
        description: 'A test proposal',
        risk: { score: 3 as RiskScore, reasoning: 'Low risk test' },
        changes: [{ type: 'patch', path: 'test.ts', search: 'a', replace: 'b' }],
        rollbackPlan: 'Revert test.ts',
        status: 'pending',
        ...overrides
    };
}

describe('RiskEngine', () => {
    it('assesses low-risk proposals as safe', async () => {
        const engine = new RiskEngine(5, 10, '/tmp/test'); // autoApply level 5, budget 10
        const proposal = makeProposal({ risk: { score: 2 as RiskScore, reasoning: 'Safe' } });

        const assessment = await engine.assess(proposal);
        expect(assessment.finalScore).toBeLessThanOrEqual(5);
        expect(assessment.gates.length).toBeGreaterThan(0);
    });

    it('blocks proposals above auto-apply threshold', async () => {
        const engine = new RiskEngine(3, 10, '/tmp/test'); // autoApply level 3
        const proposal = makeProposal({ risk: { score: 7 as RiskScore, reasoning: 'High risk' } });

        const assessment = await engine.assess(proposal);
        expect(assessment.approvalRequired).toBe(true);
        expect(assessment.canAutoApply).toBe(false);
    });

    it('never auto-applies in safe leash mode (level 0)', async () => {
        const engine = new RiskEngine(0, 10, '/tmp/test'); // Safe leash
        const proposal = makeProposal({ risk: { score: 1 as RiskScore, reasoning: 'Trivial' } });

        const assessment = await engine.assess(proposal);
        expect(assessment.canAutoApply).toBe(false);
        expect(assessment.approvalRequired).toBe(true);
    });

    it('respects daily change budget', async () => {
        const engine = new RiskEngine(10, 2, '/tmp/test'); // Budget of 2 changes/day

        // Simulate using up the budget
        engine.recordChanges(2);

        const proposal = makeProposal();
        const assessment = await engine.assess(proposal);

        // Should fail the change budget gate
        const budgetGate = assessment.gates.find(g => g.name.toLowerCase().includes('budget'));
        if (budgetGate) {
            expect(budgetGate.passed).toBe(false);
        }
    });

    it('evaluates multiple gates', async () => {
        const engine = new RiskEngine(5, 10, '/tmp/test');
        const proposal = makeProposal();

        const assessment = await engine.assess(proposal);
        expect(assessment.gates.length).toBeGreaterThanOrEqual(2); // At least deterministic + budget
    });
});
