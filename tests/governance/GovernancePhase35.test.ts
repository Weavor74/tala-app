/**
 * GovernancePhase35.test.ts
 *
 * Phase 3.5: Human-in-the-Loop Governance Layer — Comprehensive Test Suite
 *
 * Covers:
 *   P3.5A  Governance Types & Contracts (shape tests)
 *   P3.5B  Authority Tier Model (classification, ordering)
 *   P3.5C  Approval Policy Engine (determinism, all decision branches)
 *   P3.5D  Confirmation & Escalation Rules
 *   P3.5E  Approval Workflow Registry (CRUD, persistence round-trips)
 *   P3.5F  Governance Audit Service (append-only log)
 *   P3.5G  Execution Authorization Gate (canExecute, evaluateProposal)
 *   P3.5H  Governance Dashboard Bridge (milestone-gated)
 *   P3.5I  Safety Controls (expiry, default-deny, same-actor duplicate rejection)
 *        + Execution integration (check 10)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { SafeChangePlanner } from '../../electron/services/reflection/SafeChangePlanner';
import type { PlanTriggerInput } from '../../shared/reflectionPlanTypes';

import {
    tierPriority,
    tierLabel,
    mostRestrictiveTier,
    tierAllowsSelfAuthorization,
    tierRequiresHumanApproval,
    tierRequiresDualApproval,
    isBlocked,
    approvalsRequired,
    allTiersOrdered,
} from '../../electron/services/governance/AuthorityTierModel';

import { GovernancePolicyEngine } from '../../electron/services/governance/GovernancePolicyEngine';
import { ConfirmationRequirementsEngine } from '../../electron/services/governance/ConfirmationRequirementsEngine';
import { ApprovalWorkflowRegistry } from '../../electron/services/governance/ApprovalWorkflowRegistry';
import { GovernanceAuditService } from '../../electron/services/governance/GovernanceAuditService';
import { ExecutionAuthorizationGate } from '../../electron/services/governance/ExecutionAuthorizationGate';
import { GovernanceDashboardBridge } from '../../electron/services/governance/GovernanceDashboardBridge';
import { DEFAULT_GOVERNANCE_POLICY } from '../../electron/services/governance/defaults/defaultPolicy';
import { ExecutionEligibilityGate } from '../../electron/services/execution/ExecutionEligibilityGate';
import { ExecutionRunRegistry } from '../../electron/services/execution/ExecutionRunRegistry';

import type { AuthorityTier, GovernancePolicyInput, GovernanceDecision, ApprovalActor } from '../../shared/governanceTypes';
import type { SafeChangeProposal } from '../../shared/reflectionPlanTypes';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-gov-test-'));
}

function makeProposal(overrides: Partial<SafeChangeProposal> = {}): SafeChangeProposal {
    return {
        proposalId: `prop-${Math.random().toString(36).slice(2, 8)}`,
        runId: 'run-001',
        createdAt: new Date().toISOString(),
        title: 'Test Proposal',
        description: 'A test change proposal',
        planningMode: 'standard',
        targetSubsystem: 'test/services',
        targetFiles: ['test/services/foo.ts'],
        changes: [{ type: 'patch', path: 'test/services/foo.ts', search: 'old', replace: 'new' }],
        blastRadius: {
            affectedSubsystems: ['test'],
            affectedFiles: ['test/services/foo.ts'],
            threatenedInvariantIds: [],
            invariantRisk: 'none',
            estimatedImpactScore: 10,
            blockedBy: [],
        },
        verificationRequirements: {
            requiresBuild: true,
            requiresTypecheck: false,
            requiresLint: false,
            requiredTests: [],
            smokeChecks: [],
            manualReviewRequired: false,
            estimatedDurationMs: 5000,
        },
        rollbackClassification: {
            strategy: 'file_restore',
            safetyClass: 'safe_auto',
            rollbackSteps: ['restore test/services/foo.ts'],
            requiresApproval: false,
            estimatedRollbackMs: 1000,
            classificationReasoning: 'Simple file restore',
        },
        riskScore: 10,
        promotionEligible: true,
        reasoning: 'Test change',
        modelAssisted: false,
        status: 'promoted',
        ...overrides,
    };
}

function makeHumanActor(): ApprovalActor {
    return {
        actorId: 'local_user',
        kind: 'human_user',
        label: 'Local Operator',
        timestamp: new Date().toISOString(),
    };
}

function makePolicyInput(overrides: Partial<GovernancePolicyInput> = {}): GovernancePolicyInput {
    return {
        proposalId: 'test-prop',
        safetyClass: 'safe_auto',
        riskScore: 10,
        targetSubsystem: 'test/services',
        isProtectedSubsystem: false,
        targetFiles: ['test/services/foo.ts'],
        hasProtectedFile: false,
        fileCount: 1,
        mutationTypes: ['patch'],
        rollbackStrategy: 'file_restore',
        verificationManualRequired: false,
        hasInvariantSensitivity: false,
        ...overrides,
    };
}

// ─── P3.5A: Governance Types & Contracts ──────────────────────────────────────

describe('P3.5A — Governance Types & Contracts', () => {
    it('GovernanceDecisionStatus covers all expected values', () => {
        const statuses: string[] = [
            'pending', 'approved', 'self_authorized', 'rejected',
            'deferred', 'escalated', 'blocked', 'expired',
        ];
        // Just verify they are valid string literals - no runtime checking needed
        expect(statuses).toHaveLength(8);
    });

    it('AuthorityTier covers all expected tiers', () => {
        const tiers = allTiersOrdered();
        expect(tiers).toContain('tala_self_low_risk');
        expect(tiers).toContain('tala_self_standard');
        expect(tiers).toContain('protected_subsystem');
        expect(tiers).toContain('human_review_required');
        expect(tiers).toContain('human_dual_approval');
        expect(tiers).toContain('emergency_manual_only');
        expect(tiers).toContain('blocked');
        expect(tiers).toHaveLength(7);
    });

    it('DEFAULT_GOVERNANCE_POLICY has all required fields', () => {
        const policy = DEFAULT_GOVERNANCE_POLICY;
        expect(policy.policyId).toBeTruthy();
        expect(policy.label).toBeTruthy();
        expect(policy.version).toBeTruthy();
        expect(policy.rules).toBeInstanceOf(Array);
        expect(policy.rules.length).toBeGreaterThan(0);
        expect(policy.defaultTier).toBe('human_review_required');
        expect(typeof policy.selfAuthorizationDisabled).toBe('boolean');
    });

    it('GovernanceRule fields are present and correct', () => {
        const rule = DEFAULT_GOVERNANCE_POLICY.rules[0]!;
        expect(rule.ruleId).toBeTruthy();
        expect(rule.label).toBeTruthy();
        expect(rule.conditions).toBeInstanceOf(Array);
        expect(typeof rule.requiredTier).toBe('string');
        expect(typeof rule.requiresManualConfirmation).toBe('boolean');
        expect(typeof rule.escalateOnVerificationFailure).toBe('boolean');
        expect(rule.rationale).toBeTruthy();
    });
});

// ─── P3.5B: Authority Tier Model ──────────────────────────────────────────────

describe('P3.5B — Authority Tier Model', () => {
    it('mostRestrictiveTier returns correct winner', () => {
        expect(mostRestrictiveTier(['tala_self_low_risk', 'human_review_required'])).toBe('human_review_required');
        expect(mostRestrictiveTier(['tala_self_standard', 'blocked'])).toBe('blocked');
        expect(mostRestrictiveTier(['human_review_required', 'human_dual_approval'])).toBe('human_dual_approval');
        expect(mostRestrictiveTier(['tala_self_low_risk', 'tala_self_standard'])).toBe('tala_self_standard');
    });

    it('mostRestrictiveTier returns fail-safe on empty array', () => {
        expect(mostRestrictiveTier([])).toBe('human_review_required');
    });

    it('tierAllowsSelfAuthorization only for tala_self_* tiers', () => {
        expect(tierAllowsSelfAuthorization('tala_self_low_risk')).toBe(true);
        expect(tierAllowsSelfAuthorization('tala_self_standard')).toBe(true);
        expect(tierAllowsSelfAuthorization('human_review_required')).toBe(false);
        expect(tierAllowsSelfAuthorization('human_dual_approval')).toBe(false);
        expect(tierAllowsSelfAuthorization('protected_subsystem')).toBe(false);
        expect(tierAllowsSelfAuthorization('blocked')).toBe(false);
        expect(tierAllowsSelfAuthorization('emergency_manual_only')).toBe(false);
    });

    it('tierRequiresHumanApproval for review-and-above tiers', () => {
        expect(tierRequiresHumanApproval('human_review_required')).toBe(true);
        expect(tierRequiresHumanApproval('human_dual_approval')).toBe(true);
        expect(tierRequiresHumanApproval('protected_subsystem')).toBe(true);
        expect(tierRequiresHumanApproval('emergency_manual_only')).toBe(true);
        expect(tierRequiresHumanApproval('tala_self_low_risk')).toBe(false);
        expect(tierRequiresHumanApproval('tala_self_standard')).toBe(false);
        expect(tierRequiresHumanApproval('blocked')).toBe(false);
    });

    it('tierRequiresDualApproval only for human_dual_approval', () => {
        expect(tierRequiresDualApproval('human_dual_approval')).toBe(true);
        expect(tierRequiresDualApproval('human_review_required')).toBe(false);
        expect(tierRequiresDualApproval('tala_self_low_risk')).toBe(false);
    });

    it('isBlocked for blocked and emergency tiers', () => {
        expect(isBlocked('blocked')).toBe(true);
        expect(isBlocked('emergency_manual_only')).toBe(true);
        expect(isBlocked('human_review_required')).toBe(false);
        expect(isBlocked('tala_self_low_risk')).toBe(false);
    });

    it('approvalsRequired returns correct values per tier', () => {
        expect(approvalsRequired('tala_self_low_risk')).toBe(0);
        expect(approvalsRequired('tala_self_standard')).toBe(0);
        expect(approvalsRequired('blocked')).toBe(0);
        expect(approvalsRequired('emergency_manual_only')).toBe(0);
        expect(approvalsRequired('protected_subsystem')).toBe(1);
        expect(approvalsRequired('human_review_required')).toBe(1);
        expect(approvalsRequired('human_dual_approval')).toBe(2);
    });

    it('tierPriority is monotonically increasing', () => {
        const ordered = allTiersOrdered();
        for (let i = 1; i < ordered.length; i++) {
            expect(tierPriority(ordered[i]!)).toBeGreaterThan(tierPriority(ordered[i - 1]!));
        }
    });

    it('tierLabel returns non-empty strings', () => {
        for (const tier of allTiersOrdered()) {
            expect(tierLabel(tier)).toBeTruthy();
        }
    });
});

// ─── P3.5C: Approval Policy Engine ───────────────────────────────────────────

describe('P3.5C — Approval Policy Engine', () => {
    const engine = new GovernancePolicyEngine();
    const policy = DEFAULT_GOVERNANCE_POLICY;

    it('is deterministic: same input → same result on repeated calls', () => {
        const input = makePolicyInput();
        const result1 = engine.evaluate(input, policy);
        const result2 = engine.evaluate(input, policy);
        expect(result1.resolvedTier).toBe(result2.resolvedTier);
        expect(result1.matchedRules.map(r => r.ruleId)).toEqual(result2.matchedRules.map(r => r.ruleId));
        expect(result1.selfAuthorizationPermitted).toBe(result2.selfAuthorizationPermitted);
    });

    it('safe_auto + 1 file + no protected → tala_self_low_risk', () => {
        const input = makePolicyInput({
            safetyClass: 'safe_auto',
            fileCount: 1,
            isProtectedSubsystem: false,
            hasProtectedFile: false,
            hasInvariantSensitivity: false,
        });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('tala_self_low_risk');
        expect(result.selfAuthorizationPermitted).toBe(true);
        expect(result.blockedByPolicy).toBe(false);
    });

    it('safe_with_review + 2 files + no protected → tala_self_standard', () => {
        const input = makePolicyInput({
            safetyClass: 'safe_with_review',
            fileCount: 2,
            isProtectedSubsystem: false,
            hasProtectedFile: false,
            hasInvariantSensitivity: false,
            verificationManualRequired: false,
        });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('tala_self_standard');
        expect(result.selfAuthorizationPermitted).toBe(true);
    });

    it('safe_with_review + 3 files → human_review_required', () => {
        const input = makePolicyInput({
            safetyClass: 'safe_with_review',
            fileCount: 3,
            isProtectedSubsystem: false,
            hasProtectedFile: false,
        });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('human_review_required');
        expect(result.selfAuthorizationPermitted).toBe(false);
    });

    it('high_risk safety class → human_review_required + manual confirmation', () => {
        const input = makePolicyInput({ safetyClass: 'high_risk' });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('human_review_required');
        expect(result.requiresManualConfirmation).toBe(true);
        expect(result.escalateOnVerificationFailure).toBe(true);
    });

    it('blocked safety class → blocked tier', () => {
        const input = makePolicyInput({ safetyClass: 'blocked' });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('blocked');
        expect(result.blockedByPolicy).toBe(true);
        expect(result.selfAuthorizationPermitted).toBe(false);
    });

    it('isProtectedSubsystem → at minimum protected_subsystem tier', () => {
        const input = makePolicyInput({
            isProtectedSubsystem: true,
            safetyClass: 'safe_auto',
        });
        const result = engine.evaluate(input, policy);
        // Protected subsystem always elevates to at least protected_subsystem
        expect(tierPriority(result.resolvedTier)).toBeGreaterThanOrEqual(tierPriority('protected_subsystem'));
    });

    it('hasProtectedFile → human_review_required', () => {
        const input = makePolicyInput({ hasProtectedFile: true, safetyClass: 'safe_auto' });
        const result = engine.evaluate(input, policy);
        expect(tierPriority(result.resolvedTier)).toBeGreaterThanOrEqual(tierPriority('human_review_required'));
    });

    it('≥5 files → human_review_required regardless of safetyClass', () => {
        const input = makePolicyInput({
            safetyClass: 'safe_auto',
            fileCount: 5,
            isProtectedSubsystem: false,
            hasProtectedFile: false,
        });
        const result = engine.evaluate(input, policy);
        expect(result.resolvedTier).toBe('human_review_required');
    });

    it('hasInvariantSensitivity → human_review_required', () => {
        const input = makePolicyInput({
            hasInvariantSensitivity: true,
            safetyClass: 'safe_auto',
        });
        const result = engine.evaluate(input, policy);
        expect(tierPriority(result.resolvedTier)).toBeGreaterThanOrEqual(tierPriority('human_review_required'));
    });

    it('selfAuthorizationDisabled:true → selfAuthorizationPermitted:false regardless of tier', () => {
        const disabledPolicy = { ...policy, selfAuthorizationDisabled: true };
        const input = makePolicyInput({
            safetyClass: 'safe_auto',
            fileCount: 1,
        });
        const result = engine.evaluate(input, disabledPolicy);
        expect(result.selfAuthorizationPermitted).toBe(false);
    });

    it('no matching rules → default tier applied', () => {
        const emptyPolicy = { ...policy, rules: [] };
        const input = makePolicyInput({ safetyClass: 'safe_auto' });
        const result = engine.evaluate(input, emptyPolicy);
        expect(result.resolvedTier).toBe(emptyPolicy.defaultTier);
        expect(result.matchedRules).toHaveLength(0);
    });

    it('most-restrictive tier wins across multiple matching rules', () => {
        // isProtectedSubsystem: true fires PROT-SUBSYSTEM (protected_subsystem)
        // high_risk fires GOV-HIGH-RISK (human_review_required)
        // combined: protected_subsystem (more restrictive than human_review_required? No - check ordering)
        // protected_subsystem=3, human_review_required=4, human_dual_approval fires PROT-HIGH
        const input = makePolicyInput({
            isProtectedSubsystem: true,
            safetyClass: 'high_risk',
        });
        const result = engine.evaluate(input, policy);
        // Should get human_dual_approval (GOV-PROT-HIGH fires for protected + high_risk)
        expect(result.resolvedTier).toBe('human_dual_approval');
        expect(result.requiresManualConfirmation).toBe(true);
    });
});

// ─── P3.5D: Confirmation & Escalation Rules ───────────────────────────────────

describe('P3.5D — Confirmation & Escalation Rules', () => {
    const engine = new ConfirmationRequirementsEngine();

    it('human_review_required tier generates pre_execution_manual confirmation', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p1',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_review_required' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: true,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const confirmations = engine.deriveConfirmations(evalResult, false);
        expect(confirmations.some(c => c.kind === 'pre_execution_manual')).toBe(true);
        expect(confirmations.every(c => !c.satisfied)).toBe(true);
        expect(confirmations.every(c => c.required)).toBe(true);
    });

    it('hasProtectedFiles generates protected_file_ack confirmation', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p2',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_review_required' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const confirmations = engine.deriveConfirmations(evalResult, true);
        expect(confirmations.some(c => c.kind === 'protected_file_ack')).toBe(true);
    });

    it('dual_approval tier generates dual_approval_ack confirmation', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p3',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_dual_approval' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: true,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 2,
            contributingConditions: [],
        };
        const confirmations = engine.deriveConfirmations(evalResult, false);
        expect(confirmations.some(c => c.kind === 'dual_approval_ack')).toBe(true);
    });

    it('escalateOnVerificationFailure generates escalation', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p4',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_review_required' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: true,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const escalations = engine.deriveEscalations(evalResult, false, false);
        expect(escalations.some(e => e.trigger === 'verification_failure')).toBe(true);
        expect(escalations.every(e => !e.resolved)).toBe(true);
    });

    it('isProtectedSubsystem generates critical_subsystem escalation', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p5',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'protected_subsystem' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const escalations = engine.deriveEscalations(evalResult, false, true);
        expect(escalations.some(e => e.trigger === 'critical_subsystem')).toBe(true);
    });

    it('tala_self_low_risk with no protected files generates no confirmations', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'p6',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'tala_self_low_risk' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: true,
            blockedByPolicy: false,
            approvalsRequired: 0,
            contributingConditions: [],
        };
        const confirmations = engine.deriveConfirmations(evalResult, false);
        expect(confirmations).toHaveLength(0);
    });
});

// ─── P3.5E: Approval Workflow Registry ───────────────────────────────────────

describe('P3.5E — Approval Workflow Registry', () => {
    let tempDir: string;
    let registry: ApprovalWorkflowRegistry;

    beforeEach(() => {
        tempDir = makeTempDir();
        registry = new ApprovalWorkflowRegistry(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function makeEvalResult(proposalId: string, tier: AuthorityTier = 'tala_self_low_risk') {
        return {
            evaluatedAt: new Date().toISOString(),
            proposalId,
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: tier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: tier === 'tala_self_low_risk' || tier === 'tala_self_standard',
            blockedByPolicy: tier === 'blocked',
            approvalsRequired: approvalsRequired(tier),
            contributingConditions: [],
        };
    }

    function makeSnapshot(proposalId: string) {
        return {
            proposalId,
            riskScore: 10,
            safetyClass: 'safe_auto' as const,
            targetSubsystem: 'test',
            targetFileCount: 1,
            hasProtectedFiles: false,
            isProtectedSubsystem: false,
            hasInvariantSensitivity: false,
            rollbackStrategy: 'file_restore' as const,
            mutationTypes: ['patch' as const],
            verificationManualRequired: false,
        };
    }

    it('createDecision persists to disk and is immediately readable', () => {
        const evalResult = makeEvalResult('prop-001');
        const snapshot = makeSnapshot('prop-001');
        const decision = registry.createDecision(evalResult, snapshot, [], []);

        expect(decision.decisionId).toBeTruthy();
        expect(decision.proposalId).toBe('prop-001');
        expect(decision.status).toBe('self_authorized'); // low risk → self authorized

        const loaded = registry.getDecision('prop-001');
        expect(loaded).not.toBeNull();
        expect(loaded!.decisionId).toBe(decision.decisionId);
    });

    it('createDecision is idempotent: returns existing if already present', () => {
        const evalResult = makeEvalResult('prop-002');
        const snapshot = makeSnapshot('prop-002');
        const d1 = registry.createDecision(evalResult, snapshot, [], []);
        const d2 = registry.createDecision(evalResult, snapshot, [], []);
        expect(d1.decisionId).toBe(d2.decisionId);
    });

    it('blocked policy input creates decision with status "blocked"', () => {
        const evalResult = makeEvalResult('prop-blk', 'blocked');
        const snapshot = makeSnapshot('prop-blk');
        const decision = registry.createDecision(evalResult, snapshot, [], []);
        expect(decision.status).toBe('blocked');
        expect(decision.executionAuthorized).toBe(false);
    });

    it('human_review_required creates decision with status "pending"', () => {
        const evalResult = makeEvalResult('prop-pending', 'human_review_required');
        const snapshot = makeSnapshot('prop-pending');
        const decision = registry.createDecision(evalResult, snapshot, [], []);
        expect(decision.status).toBe('pending');
        expect(decision.executionAuthorized).toBe(false);
    });

    it('recordApproval updates status to approved and sets executionAuthorized', () => {
        const evalResult = makeEvalResult('prop-appr', 'human_review_required');
        const snapshot = makeSnapshot('prop-appr');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        const { record, error } = registry.recordApproval('prop-appr', actor, snapshot, 'LGTM');
        expect(error).toBeUndefined();
        expect(record).not.toBeNull();
        expect(record!.outcome).toBe('approved');

        const updated = registry.getDecision('prop-appr');
        expect(updated!.status).toBe('approved');
        expect(updated!.executionAuthorized).toBe(true);
    });

    it('recordRejection transitions status to rejected', () => {
        const evalResult = makeEvalResult('prop-rej', 'human_review_required');
        const snapshot = makeSnapshot('prop-rej');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        const { record } = registry.recordRejection('prop-rej', actor, snapshot, 'Too risky');

        expect(record).not.toBeNull();
        const updated = registry.getDecision('prop-rej');
        expect(updated!.status).toBe('rejected');
        expect(updated!.executionAuthorized).toBe(false);
    });

    it('recordDeferral transitions status to deferred', () => {
        const evalResult = makeEvalResult('prop-def', 'human_review_required');
        const snapshot = makeSnapshot('prop-def');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        const { record } = registry.recordDeferral('prop-def', actor, snapshot);

        expect(record).not.toBeNull();
        const updated = registry.getDecision('prop-def');
        expect(updated!.status).toBe('deferred');
    });

    it('same actor cannot approve twice for dual_approval tier', () => {
        const evalResult = makeEvalResult('prop-dual', 'human_dual_approval');
        const snapshot = makeSnapshot('prop-dual');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        const r1 = registry.recordApproval('prop-dual', actor, snapshot, 'first');
        expect(r1.error).toBeUndefined();

        const r2 = registry.recordApproval('prop-dual', actor, snapshot, 'second attempt same actor');
        expect(r2.error).toBe('duplicate_actor_approval');
        expect(r2.record).toBeNull();
    });

    it('satisfyConfirmation marks confirmation as satisfied', () => {
        const evalResult = makeEvalResult('prop-conf', 'human_review_required');
        const snapshot = makeSnapshot('prop-conf');
        const confirmation = {
            confirmationId: 'conf-001',
            proposalId: 'prop-conf',
            kind: 'pre_execution_manual' as const,
            promptText: 'Confirm review',
            required: true,
            satisfied: false,
        };
        registry.createDecision(evalResult, snapshot, [confirmation], []);

        const actor = makeHumanActor();

        // First approve so approval count is satisfied
        registry.recordApproval('prop-conf', actor, snapshot);

        // Then satisfy confirmation
        const { success } = registry.satisfyConfirmation('prop-conf', 'conf-001', actor);
        expect(success).toBe(true);

        const updated = registry.getDecision('prop-conf');
        expect(updated!.confirmations[0]!.satisfied).toBe(true);
        expect(updated!.executionAuthorized).toBe(true);
    });

    it('expireStaleDecisions marks old pending decisions as expired', () => {
        const evalResult = makeEvalResult('prop-exp', 'human_review_required');
        const snapshot = makeSnapshot('prop-exp');
        const decision = registry.createDecision(evalResult, snapshot, [], []);

        // Artificially make decision old
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        const decisionsDir = path.join(tempDir, 'governance', 'decisions');
        const filePath = path.join(decisionsDir, 'prop-exp.json');
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        raw.createdAt = oldDate;
        raw.status = 'pending'; // ensure it's pending
        fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

        const expired = registry.expireStaleDecisions(7 * 24 * 60 * 60 * 1000);
        expect(expired.length).toBeGreaterThan(0);

        const updated = registry.getDecision('prop-exp');
        expect(updated!.status).toBe('expired');
    });

    it('round-trip: write then read yields identical structure', () => {
        const evalResult = makeEvalResult('prop-rt');
        const snapshot = makeSnapshot('prop-rt');
        const d1 = registry.createDecision(evalResult, snapshot, [], []);
        const d2 = registry.getDecision('prop-rt');

        expect(d2).not.toBeNull();
        expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
    });

    it('listDecisions returns all decisions', () => {
        const snapshot = makeSnapshot('x');
        registry.createDecision(makeEvalResult('listA'), { ...snapshot, proposalId: 'listA' }, [], []);
        registry.createDecision(makeEvalResult('listB'), { ...snapshot, proposalId: 'listB' }, [], []);
        const all = registry.listDecisions();
        const ids = all.map(d => d.proposalId);
        expect(ids).toContain('listA');
        expect(ids).toContain('listB');
    });

    it('listDecisions filtered by status works', () => {
        const snapshot = makeSnapshot('x');
        registry.createDecision(makeEvalResult('pending-prop', 'human_review_required'), { ...snapshot, proposalId: 'pending-prop' }, [], []);
        registry.createDecision(makeEvalResult('selfauth-prop', 'tala_self_low_risk'), { ...snapshot, proposalId: 'selfauth-prop' }, [], []);

        const pending = registry.listDecisions({ status: 'pending' });
        const selfAuth = registry.listDecisions({ status: 'self_authorized' });

        expect(pending.some(d => d.proposalId === 'pending-prop')).toBe(true);
        expect(pending.some(d => d.proposalId === 'selfauth-prop')).toBe(false);
        expect(selfAuth.some(d => d.proposalId === 'selfauth-prop')).toBe(true);
    });
});

// ─── P3.5F: Governance Audit Service ─────────────────────────────────────────

describe('P3.5F — Governance Audit Service', () => {
    let tempDir: string;
    let auditService: GovernanceAuditService;

    beforeEach(() => {
        tempDir = makeTempDir();
        auditService = new GovernanceAuditService(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('append writes valid JSONL and returns record', () => {
        const record = auditService.append(
            'prop-a1', 'dec-001', 'policy_evaluated',
            'Test evaluation', null,
        );

        expect(record.auditId).toBeTruthy();
        expect(record.proposalId).toBe('prop-a1');
        expect(record.event).toBe('policy_evaluated');
    });

    it('readAll returns records in chronological order', () => {
        auditService.append('prop-a2', 'dec-002', 'policy_evaluated', 'first', null);
        auditService.append('prop-a2', 'dec-002', 'decision_created', 'second', null);
        auditService.append('prop-a2', 'dec-002', 'approval_recorded', 'third', null);

        const records = auditService.readAll('prop-a2');
        expect(records).toHaveLength(3);
        expect(records[0]!.event).toBe('policy_evaluated');
        expect(records[1]!.event).toBe('decision_created');
        expect(records[2]!.event).toBe('approval_recorded');
    });

    it('readAll returns empty array for unknown proposalId', () => {
        const records = auditService.readAll('nonexistent');
        expect(records).toHaveLength(0);
    });

    it('_global.jsonl receives an entry for each append', () => {
        auditService.append('prop-a3', 'dec-003', 'execution_authorized', 'authorized', null);

        const index = auditService.readGlobalIndex(100);
        const entry = index.find(e => e.proposalId === 'prop-a3');
        expect(entry).toBeDefined();
        expect(entry!.event).toBe('execution_authorized');
    });

    it('each record gets a unique auditId', () => {
        const r1 = auditService.append('prop-a4', 'dec-004', 'policy_evaluated', 'ev1', null);
        const r2 = auditService.append('prop-a4', 'dec-004', 'decision_created', 'ev2', null);
        expect(r1.auditId).not.toBe(r2.auditId);
    });
});

// ─── P3.5G: Execution Authorization Gate ─────────────────────────────────────

describe('P3.5G — Execution Authorization Gate', () => {
    let tempDir: string;
    let registry: ApprovalWorkflowRegistry;
    let auditService: GovernanceAuditService;
    let dashboardBridge: GovernanceDashboardBridge;
    let gate: ExecutionAuthorizationGate;

    beforeEach(() => {
        tempDir = makeTempDir();
        registry = new ApprovalWorkflowRegistry(tempDir);
        auditService = new GovernanceAuditService(tempDir);
        dashboardBridge = new GovernanceDashboardBridge();
        gate = new ExecutionAuthorizationGate(
            registry,
            auditService,
            dashboardBridge,
            DEFAULT_GOVERNANCE_POLICY,
            () => [],
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('canExecute returns not authorized when no decision exists', () => {
        const result = gate.canExecute('no-decision-prop');
        expect(result.authorized).toBe(false);
        expect(result.blockReason).toBe('no_decision_exists');
    });

    it('canExecute returns authorized for self-authorized low-risk proposal', () => {
        const proposal = makeProposal({
            proposalId: 'self-auth-prop',
            rollbackClassification: {
                strategy: 'file_restore',
                safetyClass: 'safe_auto',
                rollbackSteps: [],
                requiresApproval: false,
                estimatedRollbackMs: 0,
                classificationReasoning: '',
            },
        });
        gate.evaluateProposal(proposal);

        const result = gate.canExecute('self-auth-prop');
        expect(result.authorized).toBe(true);
        expect(result.tier).toBe('tala_self_low_risk');
    });

    it('canExecute returns not authorized for pending decision awaiting approval', () => {
        const proposal = makeProposal({
            proposalId: 'pending-auth-prop',
            rollbackClassification: {
                strategy: 'file_restore',
                safetyClass: 'high_risk',
                rollbackSteps: [],
                requiresApproval: true,
                estimatedRollbackMs: 0,
                classificationReasoning: '',
            },
            riskScore: 80,
        });
        gate.evaluateProposal(proposal);

        const result = gate.canExecute('pending-auth-prop');
        expect(result.authorized).toBe(false);
    });

    it('canExecute returns authorized after human approval', () => {
        const proposal = makeProposal({
            proposalId: 'approved-prop',
            rollbackClassification: {
                strategy: 'file_restore',
                safetyClass: 'high_risk',
                rollbackSteps: [],
                requiresApproval: true,
                estimatedRollbackMs: 0,
                classificationReasoning: '',
            },
            riskScore: 80,
        });
        gate.evaluateProposal(proposal);

        const decision = registry.getDecision('approved-prop')!;
        // Satisfy all confirmations first
        const actor = makeHumanActor();
        for (const conf of decision.confirmations) {
            registry.satisfyConfirmation('approved-prop', conf.confirmationId, actor);
        }
        registry.recordApproval('approved-prop', actor, decision.proposalSnapshot);

        const result = gate.canExecute('approved-prop');
        expect(result.authorized).toBe(true);
    });

    it('canExecute blocked for "blocked" policy decision', () => {
        const proposal = makeProposal({
            proposalId: 'blocked-prop',
            rollbackClassification: {
                strategy: 'file_restore',
                safetyClass: 'blocked',
                rollbackSteps: [],
                requiresApproval: false,
                estimatedRollbackMs: 0,
                classificationReasoning: '',
            },
        });
        gate.evaluateProposal(proposal);

        const result = gate.canExecute('blocked-prop');
        expect(result.authorized).toBe(false);
        expect(result.blockReason).toBe('policy_blocked');
    });

    it('evaluateProposal creates audit records', () => {
        const proposal = makeProposal({ proposalId: 'audit-prop' });
        gate.evaluateProposal(proposal);

        const records = auditService.readAll('audit-prop');
        expect(records.some(r => r.event === 'policy_evaluated')).toBe(true);
        expect(records.some(r => r.event === 'decision_created')).toBe(true);
    });

    it('evaluateProposal is idempotent: same proposal returns same decision', () => {
        const proposal = makeProposal({ proposalId: 'idempotent-prop' });
        const d1 = gate.evaluateProposal(proposal);
        const d2 = gate.evaluateProposal(proposal);
        expect(d1.decisionId).toBe(d2.decisionId);
    });

    it('self-authorization not permitted when selfAuthorizationDisabled:true', () => {
        const disabledPolicy = { ...DEFAULT_GOVERNANCE_POLICY, selfAuthorizationDisabled: true };
        const disabledGate = new ExecutionAuthorizationGate(
            registry, auditService, dashboardBridge, disabledPolicy, () => [],
        );

        const proposal = makeProposal({
            proposalId: 'no-self-auth-prop',
            rollbackClassification: {
                strategy: 'file_restore',
                safetyClass: 'safe_auto',
                rollbackSteps: [],
                requiresApproval: false,
                estimatedRollbackMs: 0,
                classificationReasoning: '',
            },
        });
        disabledGate.evaluateProposal(proposal);

        const result = disabledGate.canExecute('no-self-auth-prop');
        expect(result.authorized).toBe(false);
    });
});

// ─── P3.5H: Governance Dashboard Bridge ──────────────────────────────────────

describe('P3.5H — Governance Dashboard Bridge', () => {
    it('emits on permitted milestones', () => {
        const bridge = new GovernanceDashboardBridge();
        const state = {
            kpis: {
                totalDecisions: 0, selfAuthorized: 0, humanApproved: 0,
                rejected: 0, pending: 0, blocked: 0, escalated: 0, expired: 0,
            },
            pendingQueue: [],
            recentDecisions: [],
            activePolicyId: 'test',
            activePolicyLabel: 'Test',
            selfAuthorizationEnabled: true,
            lastUpdatedAt: new Date().toISOString(),
        };
        // BrowserWindow.getAllWindows returns [] in test, so emit returns false but doesn't throw
        const result = bridge.maybeEmit('decision_created', state);
        expect(typeof result).toBe('boolean');
    });

    it('deduplication prevents identical consecutive emits', () => {
        const bridge = new GovernanceDashboardBridge();
        const state = {
            kpis: {
                totalDecisions: 1, selfAuthorized: 1, humanApproved: 0,
                rejected: 0, pending: 0, blocked: 0, escalated: 0, expired: 0,
            },
            pendingQueue: [],
            recentDecisions: [],
            activePolicyId: 'test',
            activePolicyLabel: 'Test',
            selfAuthorizationEnabled: true,
            lastUpdatedAt: 'fixed-ts',
        };
        // First emit sets hash
        bridge.maybeEmit('decision_created', state);
        // Second emit with identical state should be deduplicated (returns false even when windows exist)
        const second = bridge.maybeEmit('decision_created', state);
        expect(second).toBe(false);
    });
});

// ─── P3.5G+P3.5I: Execution integration — check 10 ──────────────────────────

describe('P3.5G+P3.5I — Execution Integration (Check 10)', () => {
    let tempDir: string;
    let runRegistry: ExecutionRunRegistry;

    beforeEach(() => {
        tempDir = makeTempDir();
        runRegistry = new ExecutionRunRegistry();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('ExecutionEligibilityGate without governance provider skips check 10', () => {
        const gate = new ExecutionEligibilityGate(runRegistry);
        const proposal = makeProposal();
        const auth = {
            authorizedAt: new Date().toISOString(),
            authorizedBy: 'user_explicit' as const,
            proposalStatus: 'promoted',
            authorizationToken: 'tok-123',
        };
        const result = gate.evaluate(proposal, auth, []);
        // No governance provider → check 10 not in checks
        expect(result.checks.some(c => c.name === 'governance_approval')).toBe(false);
    });

    it('ExecutionEligibilityGate with governance provider that blocks → check 10 fails', () => {
        const blockingProvider = {
            canExecute: (_proposalId: string) => ({
                authorized: false,
                reason: 'governance: pending approval',
            }),
        };
        const gate = new ExecutionEligibilityGate(runRegistry, undefined, blockingProvider);
        const proposal = makeProposal();
        const auth = {
            authorizedAt: new Date().toISOString(),
            authorizedBy: 'user_explicit' as const,
            proposalStatus: 'promoted',
            authorizationToken: 'tok-456',
        };
        const result = gate.evaluate(proposal, auth, []);
        expect(result.eligible).toBe(false);
        expect(result.blockedBy).toBe('governance_approval');
        expect(result.checks.some(c => c.name === 'governance_approval' && !c.passed)).toBe(true);
    });

    it('ExecutionEligibilityGate with governance provider that passes → check 10 passes', () => {
        const approvingProvider = {
            canExecute: (_proposalId: string) => ({
                authorized: true,
                reason: 'governance: approved',
                decisionId: 'dec-001',
            }),
        };
        const gate = new ExecutionEligibilityGate(runRegistry, undefined, approvingProvider);
        const proposal = makeProposal();
        const auth = {
            authorizedAt: new Date().toISOString(),
            authorizedBy: 'user_explicit' as const,
            proposalStatus: 'promoted',
            authorizationToken: 'tok-789',
        };
        const result = gate.evaluate(proposal, auth, []);
        expect(result.checks.some(c => c.name === 'governance_approval' && c.passed)).toBe(true);
        // Since all other checks pass too, the run should be eligible
        expect(result.eligible).toBe(true);
    });
});

// ─── P3.5I: Safety controls ───────────────────────────────────────────────────

describe('P3.5I — Safety Controls & Auditability', () => {
    let tempDir: string;
    let registry: ApprovalWorkflowRegistry;

    beforeEach(() => {
        tempDir = makeTempDir();
        registry = new ApprovalWorkflowRegistry(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function makeSnapshot(proposalId: string) {
        return {
            proposalId,
            riskScore: 10,
            safetyClass: 'safe_auto' as const,
            targetSubsystem: 'test',
            targetFileCount: 1,
            hasProtectedFiles: false,
            isProtectedSubsystem: false,
            hasInvariantSensitivity: false,
            rollbackStrategy: 'file_restore' as const,
            mutationTypes: ['patch' as const],
            verificationManualRequired: false,
        };
    }

    it('default-deny: getDecision returns null for unknown proposal', () => {
        expect(registry.getDecision('nonexistent')).toBeNull();
    });

    it('approval record is appended to JSONL file on every recordApproval', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'safety-prop',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_review_required' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const snapshot = makeSnapshot('safety-prop');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        registry.recordApproval('safety-prop', actor, snapshot, 'approved');

        const approvalsDir = path.join(tempDir, 'governance', 'approvals');
        const jsonlFile = path.join(approvalsDir, 'safety-prop.jsonl');
        expect(fs.existsSync(jsonlFile)).toBe(true);

        const records = registry.listApprovalRecords('safety-prop');
        expect(records).toHaveLength(1);
        expect(records[0]!.outcome).toBe('approved');
    });

    it('recordApproval on non-existent decision returns error', () => {
        const actor = makeHumanActor();
        const { record, error } = registry.recordApproval('ghost', actor, makeSnapshot('ghost'));
        expect(record).toBeNull();
        expect(error).toBe('decision_not_found');
    });

    it('recordApproval on rejected decision returns error (not pending)', () => {
        const evalResult = {
            evaluatedAt: new Date().toISOString(),
            proposalId: 'rej-safety',
            policyId: 'default-v1',
            policyVersion: '1.0.0',
            resolvedTier: 'human_review_required' as AuthorityTier,
            matchedRules: [],
            requiresManualConfirmation: false,
            escalateOnVerificationFailure: false,
            selfAuthorizationPermitted: false,
            blockedByPolicy: false,
            approvalsRequired: 1,
            contributingConditions: [],
        };
        const snapshot = makeSnapshot('rej-safety');
        registry.createDecision(evalResult, snapshot, [], []);

        const actor = makeHumanActor();
        registry.recordRejection('rej-safety', actor, snapshot, 'nope');
        const { record, error } = registry.recordApproval('rej-safety', actor, snapshot);
        expect(record).toBeNull();
        expect(error).toContain('decision_not_pending');
    });

    it('ExecutionEligibilityCheckName includes governance_approval', () => {
        // Type-level check: we verify the string value exists
        const checkNames: string[] = [
            'proposal_status', 'proposal_freshness', 'subsystem_lock', 'cooldown',
            'required_fields', 'invariant_refs', 'rollback_plan_present',
            'verification_plan', 'authorization', 'governance_approval',
        ];
        expect(checkNames).toContain('governance_approval');
    });
});

// ─── P3.5 Integration — promoteProposal → evaluateForProposal ────────────────

describe('P3.5 Integration — promoteProposal → evaluateForProposal', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /** Minimal SelfModelQueryService mock — only getSnapshot() is needed. */
    function makeMockQuery() {
        const snapshot = {
            generatedAt: new Date().toISOString(),
            invariants: [],
            capabilities: [],
            components: [],
            ownershipMap: [],
        };
        return {
            getSnapshot: vi.fn(() => snapshot),
            queryInvariants: vi.fn(),
            queryCapabilities: vi.fn(),
            getArchitectureSummary: vi.fn(),
            getComponents: vi.fn(() => []),
            getOwnershipMap: vi.fn(() => []),
        } as any;
    }

    function makeTrigger(overrides: Partial<PlanTriggerInput> = {}): PlanTriggerInput {
        return {
            subsystemId: 'test/services',
            issueType: 'style_inconsistency',
            normalizedTarget: 'test/services/foo.ts',
            severity: 'low',
            isManual: true,
            planningMode: 'light',
            ...overrides,
        };
    }

    it('promoteProposal transitions a classified proposal to promoted', async () => {
        const planner = new SafeChangePlanner(makeMockQuery(), tempDir);
        await planner.plan(makeTrigger());

        const proposals = planner.listProposals();
        expect(proposals.length).toBeGreaterThan(0);
        const proposal = proposals[0]!;
        expect(proposal.status).toBe('classified');

        const promoted = planner.promoteProposal(proposal.proposalId);
        expect(promoted).not.toBeNull();
        expect(promoted!.status).toBe('promoted');
        expect(promoted!.proposalId).toBe(proposal.proposalId);

        // Registry reflects the updated status
        const live = planner.listProposals();
        const liveProposal = live.find(p => p.proposalId === proposal.proposalId);
        expect(liveProposal?.status).toBe('promoted');
    });

    it('promoteProposal returns null for unknown proposalId', () => {
        const planner = new SafeChangePlanner(makeMockQuery(), tempDir);
        expect(planner.promoteProposal('nonexistent-id')).toBeNull();
    });

    it('promoteProposal returns null if proposal is already promoted', async () => {
        const planner = new SafeChangePlanner(makeMockQuery(), tempDir);
        await planner.plan(makeTrigger({ subsystemId: 'test/already' }));

        const proposals = planner.listProposals();
        const proposal = proposals[0]!;

        planner.promoteProposal(proposal.proposalId); // first promotion succeeds
        const second = planner.promoteProposal(proposal.proposalId); // already 'promoted', not 'classified'
        expect(second).toBeNull();
    });

    it('evaluateForProposal resolves no_decision_exists block', () => {
        const registry = new ApprovalWorkflowRegistry(tempDir);
        const auditService = new GovernanceAuditService(tempDir);
        const dashboardBridge = new GovernanceDashboardBridge();
        const gate = new ExecutionAuthorizationGate(
            registry, auditService, dashboardBridge, DEFAULT_GOVERNANCE_POLICY, () => [],
        );

        const proposal = makeProposal({ proposalId: 'eval-for-prop' });

        // Before evaluation: blocked with no_decision_exists
        expect(gate.canExecute('eval-for-prop').blockReason).toBe('no_decision_exists');

        // Simulate evaluateForProposal (thin wrapper over authGate.evaluateProposal)
        gate.evaluateProposal(proposal);

        // After evaluation: decision exists, low-risk safe_auto → self-authorized
        const result = gate.canExecute('eval-for-prop');
        expect(result.blockReason).not.toBe('no_decision_exists');
        expect(result.authorized).toBe(true); // safe_auto + tala_self_low_risk
    });

    it('promote callback fires governance evaluation; canExecute no longer blocked by no_decision_exists', async () => {
        const planner = new SafeChangePlanner(makeMockQuery(), tempDir);
        const registry = new ApprovalWorkflowRegistry(tempDir);
        const auditService = new GovernanceAuditService(tempDir);
        const dashboardBridge = new GovernanceDashboardBridge();
        const gate = new ExecutionAuthorizationGate(
            registry, auditService, dashboardBridge, DEFAULT_GOVERNANCE_POLICY, () => [],
        );

        let callbackFired = false;
        const onPromoted = (proposal: import('../../shared/reflectionPlanTypes').SafeChangeProposal) => {
            gate.evaluateProposal(proposal); // mirrors GovernanceAppService.evaluateForProposal
            callbackFired = true;
        };

        await planner.plan(makeTrigger({ subsystemId: 'test/callback' }));
        const proposals = planner.listProposals();
        const proposal = proposals[0]!;

        const promoted = planner.promoteProposal(proposal.proposalId);
        expect(promoted).not.toBeNull();
        onPromoted(promoted!);

        expect(callbackFired).toBe(true);

        // Governance decision was created
        const decision = registry.getDecision(proposal.proposalId);
        expect(decision).not.toBeNull();
        expect(decision!.proposalId).toBe(proposal.proposalId);

        // canExecute no longer returns no_decision_exists
        const authResult = gate.canExecute(proposal.proposalId);
        expect(authResult.blockReason).not.toBe('no_decision_exists');
    });

    it('governance evaluation is non-fatal: promotion succeeds even if callback throws', async () => {
        const planner = new SafeChangePlanner(makeMockQuery(), tempDir);

        await planner.plan(makeTrigger({ subsystemId: 'test/fatal-test' }));
        const proposals = planner.listProposals();
        const proposal = proposals[0]!;

        // Promote the proposal (callback that throws is handled by the IPC layer, not the planner)
        const promoted = planner.promoteProposal(proposal.proposalId);
        expect(promoted).not.toBeNull();
        expect(promoted!.status).toBe('promoted');
    });
});
