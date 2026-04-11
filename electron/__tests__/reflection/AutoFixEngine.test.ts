import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../services/reflection/ArtifactStore';
import { AutoFixEngine } from '../../services/reflection/AutoFixEngine';
import { AutoFixProposal } from '../../services/reflection/AutoFixTypes';
import { ReflectionIssue } from '../../services/reflection/reflectionEcosystemTypes';

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('AutoFixEngine', () => {
    let rootDir: string;
    let dataDir: string;
    let logsDir: string;
    let settingsPath: string;
    let artifactStore: ArtifactStore;
    let engine: AutoFixEngine;

    beforeEach(() => {
        const testRootBase = path.join(process.cwd(), 'data', 'temp', 'tests');
        fs.mkdirSync(testRootBase, { recursive: true });
        rootDir = fs.mkdtempSync(path.join(testRootBase, 'tala-autofix-'));
        dataDir = path.join(rootDir, 'data');
        logsDir = path.join(dataDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        settingsPath = path.join(dataDir, 'app_settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            reflection: {
                enabled: true,
                autoFix: {
                    minConfidence: 0.7,
                    cooldowns: {
                        proposedMinutes: 30,
                        appliedSuccessMinutes: 240,
                        failedMinutes: 60,
                        blockedMinutes: 120,
                        approvalRequiredMinutes: 240,
                        rolledBackMinutes: 180,
                    },
                }
            },
            inference: { suppressedProviders: [] },
            agentModes: { modes: { hybrid: { allowShellRun: false, allowFsWrite: 'confirm' } } },
        }, null, 2), 'utf-8');

        artifactStore = new ArtifactStore(rootDir);
        engine = new AutoFixEngine({
            artifactStore,
            settingsPath,
            logsDir,
            cacheDir: path.join(dataDir, 'cache'),
            logLifecycleConfig: {
                maxActiveFileBytes: 1024,
                rotatedRetentionCount: 3,
            }
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    async function persistProposal(proposal: AutoFixProposal) {
        await artifactStore.saveAutoFixProposal(proposal);
        return proposal;
    }

    function baseProposal(overrides: Partial<AutoFixProposal>): AutoFixProposal {
        const now = new Date().toISOString();
        const proposal: AutoFixProposal = {
            proposalId: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            sourceRunId: 'run_1',
            category: 'config',
            issueType: 'test',
            targetType: 'config_key',
            targetKey: 'reflection.heartbeatMinutes',
            actionType: 'update_config_value',
            description: 'update config',
            rationale: 'test',
            evidenceSummary: 'evidence',
            riskLevel: 'low',
            confidence: 0.92,
            autoApplicable: true,
            requiresApproval: false,
            rollbackPlan: 'restore previous value',
            verificationPlan: 'read back config',
            status: 'proposed',
            createdAt: now,
            updatedAt: now,
            proposedValue: 45,
            ...overrides,
        };
        if (!proposal.dedupeKey) {
            proposal.dedupeKey = `k_${proposal.category}_${proposal.issueType}_${proposal.actionType}_${proposal.targetKey || proposal.targetPath || proposal.targetType}`;
        }
        if (!proposal.targetLockKey) {
            proposal.targetLockKey = proposal.targetKey
                ? `target:key:${proposal.targetKey}`
                : proposal.targetPath
                    ? `target:path:${proposal.targetPath.toLowerCase()}`
                    : `target:proposal:${proposal.proposalId}`;
        }
        return proposal;
    }

    function reflectionIssue(overrides: Partial<ReflectionIssue> = {}): ReflectionIssue {
        const now = new Date().toISOString();
        return {
            issueId: `iss_${Date.now()}`,
            createdAt: now,
            updatedAt: now,
            title: 'test issue',
            trigger: 'manual',
            mode: 'engineering',
            severity: 'medium',
            confidence: 0.9,
            symptoms: ['errors found in logs'],
            reproductionSteps: [],
            evidenceRefs: [],
            relatedLogs: [],
            affectedFiles: ['electron/services/AgentService.ts'],
            probableLayer: 'runtime',
            rootCauseHypotheses: [],
            status: 'open',
            requestedBy: 'test',
            source: 'test',
            ...overrides,
        };
    }

    it('identical synthesized proposals resolve to same dedupeKey', async () => {
        const first = await engine.synthesizeProposals('run_a', reflectionIssue({ affectedFiles: [] }));
        const second = await engine.synthesizeProposals('run_b', reflectionIssue({ affectedFiles: [] }));

        expect(first[0].dedupeKey).toBeTruthy();
        expect(first[0].dedupeKey).toBe(second[0].dedupeKey);
    });

    it('duplicate proposal merges into existing with updated counters', async () => {
        const first = await engine.synthesizeProposals('run_a', reflectionIssue({ affectedFiles: [] }));
        const second = await engine.synthesizeProposals('run_b', reflectionIssue({ affectedFiles: [] }));

        expect(first[0].proposalId).toBe(second[0].proposalId);
        expect(second[0].duplicateCount).toBeGreaterThan(0);
        expect(second[0].observationCount).toBeGreaterThan(1);
        expect(second[0].lastSeenAt).toBeTruthy();
    });

    it('applies low-risk config proposal successfully', async () => {
        const proposal = await persistProposal(baseProposal({}));
        const result = await engine.runProposal(proposal.proposalId);

        expect(result.success).toBe(true);
        expect(result.gate?.decision).toBe('auto_apply_allowed');
        expect(result.outcome?.status).toBe('completed');
    });

    it('recent successful proposal suppresses immediate retry via cooldown', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 71 }));
        const first = await engine.runProposal(proposal.proposalId);
        const second = await engine.runProposal(proposal.proposalId);

        expect(first.success).toBe(true);
        expect(second.success).toBe(false);
        expect(second.outcome?.status).toBe('skipped_cooldown');
    });

    it('failed proposal enters cooldown and immediate retry is skipped', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 33 }));
        vi.spyOn<any, any>(engine as any, 'verifyProposal').mockResolvedValueOnce({ result: 'failed', message: 'forced_failure' });

        const first = await engine.runProposal(proposal.proposalId);
        const second = await engine.runProposal(proposal.proposalId);

        expect(first.success).toBe(false);
        expect(second.outcome?.status).toBe('skipped_cooldown');
    });

    it('blocked unsafe proposal is deduped on repeat synthesis', async () => {
        const issue = reflectionIssue({ affectedFiles: ['electron/services/AgentService.ts'] });
        const first = await engine.synthesizeProposals('run_a', issue, 'change code');
        const second = await engine.synthesizeProposals('run_b', issue, 'change code');

        const codeProposal = first.find(p => p.category === 'code_patch_plan');
        const codeProposalRepeat = second.find(p => p.category === 'code_patch_plan');
        expect(codeProposal?.proposalId).toBe(codeProposalRepeat?.proposalId);
        expect((codeProposalRepeat?.duplicateCount ?? 0)).toBeGreaterThan(0);
    });

    it('material severity increase bypasses cooldown and creates a new proposal', async () => {
        const first = await engine.synthesizeProposals('run_a', reflectionIssue({ severity: 'low', affectedFiles: [] }));
        const second = await engine.synthesizeProposals('run_b', reflectionIssue({ severity: 'critical', affectedFiles: [] }));

        expect(first[0].dedupeKey).toBe(second[0].dedupeKey);
        expect(first[0].proposalId).not.toBe(second[0].proposalId);
        expect(second[0].lastMaterialChangeReason).toBe('severity_increased');
    });

    it('blocks proposal targeting path outside app root', async () => {
        const outsideRootPath = path.join(path.parse(process.cwd()).root, 'outside', 'bad.json');
        const proposal = await persistProposal(baseProposal({
            targetType: 'path',
            targetPath: outsideRootPath,
            actionType: 'rotate_log',
            category: 'storage_maintenance',
            targetKey: undefined,
            rollbackPlan: 'not_applicable: maintenance',
        }));

        const result = await engine.runProposal(proposal.proposalId);
        expect(result.success).toBe(false);
        expect(result.gate?.decision).toBe('blocked_external_path');
    });

    it('target lock blocks concurrent execution on same target', async () => {
        const p1 = await persistProposal(baseProposal({ proposalId: 'p1', proposedValue: 80 }));
        const p2 = await persistProposal(baseProposal({ proposalId: 'p2', proposedValue: 81 }));

        const applySpy = vi.spyOn<any, any>(engine as any, 'applyProposal').mockImplementation(async (proposal: AutoFixProposal) => {
            if (proposal.proposalId === 'p1') {
                await sleep(60);
            }
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            const before = settings?.reflection?.heartbeatMinutes;
            settings.reflection = settings.reflection || {};
            settings.reflection.heartbeatMinutes = proposal.proposedValue;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
            return { beforeValue: before };
        });

        const [r1, r2] = await Promise.all([
            engine.runProposal(p1.proposalId),
            engine.runProposal(p2.proposalId),
        ]);

        expect(applySpy).toHaveBeenCalled();
        expect([r1.outcome?.status, r2.outcome?.status]).toContain('skipped_target_locked');
    });

    it('unrelated targets can execute independently', async () => {
        const p1 = await persistProposal(baseProposal({ proposalId: 'p1a', targetKey: 'reflection.heartbeatMinutes', targetLockKey: 'target:key:reflection.heartbeatMinutes', proposedValue: 82 }));
        const p2 = await persistProposal(baseProposal({ proposalId: 'p2a', targetKey: 'reflection.maxProposalsPerDay', targetLockKey: 'target:key:reflection.maxProposalsPerDay', proposedValue: 9 }));

        const [r1, r2] = await Promise.all([
            engine.runProposal(p1.proposalId),
            engine.runProposal(p2.proposalId),
        ]);

        expect(r1.success).toBe(true);
        expect(r2.success).toBe(true);
    });

    it('lock releases after failure and allows next run', async () => {
        const p1 = await persistProposal(baseProposal({ proposalId: 'pf1', proposedValue: 33 }));
        const p2 = await persistProposal(baseProposal({ proposalId: 'pf2', proposedValue: 34 }));

        vi.spyOn<any, any>(engine as any, 'verifyProposal').mockResolvedValueOnce({ result: 'failed', message: 'forced_failure' });
        const first = await engine.runProposal(p1.proposalId);
        const second = await engine.runProposal(p2.proposalId);

        expect(first.success).toBe(false);
        expect(second.outcome?.status).not.toBe('skipped_target_locked');
    });

    it('dry-run does not acquire persistent lock', async () => {
        const proposal = await persistProposal(baseProposal({ proposalId: 'pdry', proposedValue: 99 }));
        const dry = await engine.dryRunProposal(proposal.proposalId);
        const run = await engine.runProposal(proposal.proposalId);

        expect(dry.plan).toBeTruthy();
        expect(run.outcome?.status).not.toBe('skipped_target_locked');
    });

    it('rotation proposal still works and verifies success', async () => {
        const runtimePath = path.join(logsDir, 'runtime-errors.jsonl');
        fs.writeFileSync(runtimePath, `${'x'.repeat(4096)}\n`, 'utf-8');
        const proposal = await persistProposal(baseProposal({
            category: 'storage_maintenance',
            actionType: 'rotate_log',
            targetType: 'path',
            targetPath: runtimePath,
            targetKey: undefined,
            targetLockKey: `target:path:${runtimePath.replace(/\\/g, '/').toLowerCase()}`,
            rollbackPlan: 'not_applicable: maintenance',
            verificationPlan: 'active log exists',
            proposedValue: undefined,
        }));

        const result = await engine.runProposal(proposal.proposalId);
        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(logsDir, 'runtime-errors.1.jsonl'))).toBe(true);
    });

    it('list APIs expose dedupe and cooldown metadata', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 66 }));
        await engine.runProposal(proposal.proposalId);

        const proposals = await engine.listProposals();
        const outcomes = await engine.listOutcomes();
        expect(proposals[0].dedupeKey).toBeTruthy();
        expect(proposals[0].cooldownUntil).toBeTruthy();
        expect(typeof proposals[0].duplicateCount).toBe('number');
        expect(outcomes[0].dedupeKey).toBeTruthy();
        expect(outcomes[0].cooldownUntil).toBeTruthy();
    });
});
