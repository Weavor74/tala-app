import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../services/reflection/ArtifactStore';
import { AutoFixEngine } from '../../services/reflection/AutoFixEngine';
import { AutoFixProposal } from '../../services/reflection/AutoFixTypes';

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
            reflection: { enabled: true, autoFix: { minConfidence: 0.7 } },
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
        return {
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
    }

    it('applies low-risk config proposal successfully', async () => {
        const proposal = await persistProposal(baseProposal({}));

        const result = await engine.runProposal(proposal.proposalId);

        expect(result.success).toBe(true);
        expect(result.gate?.decision).toBe('auto_apply_allowed');
        expect(result.outcome?.status).toBe('completed');
    });

    it('blocks high-risk code proposal with approval_required', async () => {
        const proposal = await persistProposal(baseProposal({
            category: 'code_patch_plan',
            actionType: 'emit_patch_plan',
            targetType: 'artifact',
            riskLevel: 'high',
            autoApplicable: false,
            requiresApproval: true,
            rollbackPlan: 'not_applicable: artifact-only',
            proposedValue: { affectedFiles: ['electron/services/AgentService.ts'] },
        }));

        const result = await engine.runProposal(proposal.proposalId);

        expect(result.success).toBe(false);
        expect(result.gate?.decision).toBe('approval_required');
        expect(result.outcome?.status).toBe('gated_requires_approval');
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

    it('blocks auto-apply when rollback is missing and required', async () => {
        const proposal = await persistProposal(baseProposal({
            rollbackPlan: '',
        }));

        const result = await engine.runProposal(proposal.proposalId);

        expect(result.success).toBe(false);
        expect(result.gate?.decision).toBe('blocked_missing_rollback');
    });

    it('triggers rollback when verification fails', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 33 }));
        vi.spyOn<any, any>(engine as any, 'verifyProposal').mockResolvedValue({
            result: 'failed',
            message: 'forced_failure',
        });

        const result = await engine.runProposal(proposal.proposalId);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        expect(result.success).toBe(false);
        expect(result.outcome?.status).toBe('rolled_back');
        expect(settings.reflection.heartbeatMinutes).not.toBe(33);
    });

    it('rotates oversized runtime-errors log and verifies success', async () => {
        const runtimePath = path.join(logsDir, 'runtime-errors.jsonl');
        fs.writeFileSync(runtimePath, `${'x'.repeat(4096)}\n`, 'utf-8');
        const proposal = await persistProposal(baseProposal({
            category: 'storage_maintenance',
            actionType: 'rotate_log',
            targetType: 'path',
            targetPath: runtimePath,
            targetKey: undefined,
            rollbackPlan: 'not_applicable: maintenance',
            verificationPlan: 'active log exists',
            proposedValue: undefined,
        }));

        const result = await engine.runProposal(proposal.proposalId);

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(logsDir, 'runtime-errors.1.jsonl'))).toBe(true);
        expect(fs.existsSync(runtimePath)).toBe(true);
    });

    it('applies provider suppression only when proposal is allowlisted', async () => {
        const proposal = await persistProposal(baseProposal({
            category: 'provider_suppression',
            actionType: 'suppress_provider',
            targetType: 'provider',
            targetKey: 'inference.suppressedProviders',
            proposedValue: 'ollama:local',
            rollbackPlan: 'remove provider from suppressed list',
        }));

        const result = await engine.runProposal(proposal.proposalId);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        expect(result.success).toBe(true);
        expect(settings.inference.suppressedProviders).toContain('ollama:local');
    });

    it('dry-run returns execution plan and does not mutate state', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 99 }));
        const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        const result = await engine.dryRunProposal(proposal.proposalId);
        const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        expect(result.plan).toBeTruthy();
        expect(before).toEqual(after);
    });

    it('persists outcomes with expected statuses', async () => {
        const proposal = await persistProposal(baseProposal({ proposedValue: 66 }));
        await engine.runProposal(proposal.proposalId);

        const outcomes = await engine.listOutcomes();
        expect(outcomes.length).toBeGreaterThan(0);
        expect(['completed', 'rolled_back', 'failed', 'gated_blocked', 'gated_requires_approval']).toContain(outcomes[0].status);
    });
});
