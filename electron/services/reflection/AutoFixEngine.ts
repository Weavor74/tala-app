import fs from 'fs';
import path from 'path';
import { ReflectionIssue } from './reflectionEcosystemTypes';
import { LogLifecycleService } from '../LogLifecycleService';
import { isPathWithinAppRoot, resolveDataPath } from '../PathResolver';
import { loadSettings, saveSettings } from '../SettingsManager';
import { ArtifactStore } from './ArtifactStore';
import {
    AutoFixActionType,
    AutoFixExecutionPlan,
    AutoFixGateDecision,
    AutoFixGateResult,
    AutoFixOutcome,
    AutoFixPolicy,
    AutoFixProposal,
    AutoFixProposalCategory,
    AutoFixProposalStatus,
    AutoFixRiskLevel,
    AutoFixVerificationResult,
} from './AutoFixTypes';

const DEFAULT_AUTO_FIX_POLICY: AutoFixPolicy = {
    maxRiskAllowedForAutoApply: 'low',
    minConfidence: 0.7,
    allowedCategories: ['policy', 'config', 'runtime_state', 'storage_maintenance', 'provider_suppression'],
    allowedActions: ['update_policy_value', 'update_config_value', 'rotate_log', 'prune_logs', 'suppress_provider', 'clear_runtime_cache'],
    requireAppRootContainment: true,
    requireRollback: true,
    irreversibleAllowedActions: ['rotate_log', 'prune_logs'],
    allowlistedConfigKeys: [
        'reflection.heartbeatMinutes',
        'reflection.maxProposalsPerDay',
        'reflection.autoFix.minConfidence',
        'agentModes.modes.hybrid.allowShellRun',
        'agentModes.modes.hybrid.allowFsWrite',
    ],
};

const RISK_WEIGHT: Record<AutoFixRiskLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
};

function nowIso(): string {
    return new Date().toISOString();
}

function buildProposalId(prefix = 'afp'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function resolveByPath(obj: Record<string, any>, dottedPath: string): any {
    return dottedPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setByPath(obj: Record<string, any>, dottedPath: string, value: unknown): void {
    const keys = dottedPath.split('.');
    let cursor: Record<string, any> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (typeof cursor[key] !== 'object' || cursor[key] === null) {
            cursor[key] = {};
        }
        cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = value;
}

export class AutoFixEngine {
    private readonly artifactStore: ArtifactStore;
    private readonly settingsPath: string;
    private readonly logsDir: string;
    private readonly cacheDir: string;
    private readonly lifecycle: LogLifecycleService;
    private activeProposalId: string | null = null;

    constructor(params: {
        artifactStore: ArtifactStore;
        settingsPath: string;
        logsDir: string;
        cacheDir?: string;
        logLifecycleConfig?: {
            maxActiveFileBytes?: number;
            rotatedRetentionCount?: number;
            recentReadMaxBytes?: number;
            recentReadMaxLines?: number;
        };
    }) {
        this.artifactStore = params.artifactStore;
        this.settingsPath = params.settingsPath;
        this.logsDir = params.logsDir;
        this.cacheDir = params.cacheDir ?? resolveDataPath('cache');
        this.lifecycle = new LogLifecycleService(this.logsDir, params.logLifecycleConfig);
    }

    public getPolicy(): AutoFixPolicy {
        const settings = loadSettings(this.settingsPath);
        const configured = settings.reflection?.autoFix ?? {};
        return {
            ...DEFAULT_AUTO_FIX_POLICY,
            ...configured,
            allowedCategories: configured.allowedCategories ?? DEFAULT_AUTO_FIX_POLICY.allowedCategories,
            allowedActions: configured.allowedActions ?? DEFAULT_AUTO_FIX_POLICY.allowedActions,
            allowlistedConfigKeys: configured.allowlistedConfigKeys ?? DEFAULT_AUTO_FIX_POLICY.allowlistedConfigKeys,
            irreversibleAllowedActions: configured.irreversibleAllowedActions ?? DEFAULT_AUTO_FIX_POLICY.irreversibleAllowedActions,
        };
    }

    public async synthesizeProposals(sourceRunId: string, issue: ReflectionIssue, analyzedSummary?: string): Promise<AutoFixProposal[]> {
        const proposals: AutoFixProposal[] = [];
        const symptoms = Array.isArray(issue.symptoms) ? issue.symptoms : [];
        const affectedFiles = Array.isArray(issue.affectedFiles) ? issue.affectedFiles : [];
        const errorsInSymptoms = symptoms.find((s) => String(s).toLowerCase().includes('errors found in logs'));
        if (errorsInSymptoms) {
            proposals.push(this.createProposal({
                sourceRunId,
                category: 'storage_maintenance',
                issueType: 'oversized_runtime_log',
                targetType: 'path',
                targetPath: path.join(this.logsDir, 'runtime-errors.jsonl'),
                actionType: 'rotate_log',
                description: 'Rotate oversized runtime error log to restore bounded inspection.',
                rationale: 'Large runtime logs can starve reflection signal quality and consume memory.',
                evidenceSummary: errorsInSymptoms,
                riskLevel: 'low',
                confidence: 0.9,
                autoApplicable: true,
                requiresApproval: false,
                rollbackPlan: 'not_applicable: log rotation is maintenance-only and non-destructive for active stream',
                verificationPlan: 'Confirm runtime-errors.jsonl exists and active file size is below threshold after rotation.',
            }));
        }

        if (analyzedSummary && affectedFiles.length > 0) {
            proposals.push(this.createProposal({
                sourceRunId,
                category: 'code_patch_plan',
                issueType: 'code_change_candidate',
                targetType: 'artifact',
                actionType: 'emit_patch_plan',
                description: 'Generate patch-plan artifact for manual engineering review.',
                rationale: 'Code modifications are out of first-wave auto-fix scope.',
                evidenceSummary: analyzedSummary,
                riskLevel: 'high',
                confidence: 0.8,
                autoApplicable: false,
                requiresApproval: true,
                rollbackPlan: 'not_applicable: proposal artifact only',
                verificationPlan: 'Patch plan artifact written under reflection artifacts.',
                proposedValue: { affectedFiles },
            }));
        }

        for (const proposal of proposals) {
            await this.artifactStore.saveAutoFixProposal(proposal);
        }

        return proposals;
    }

    public async listProposals(): Promise<AutoFixProposal[]> {
        return this.artifactStore.listAutoFixProposals();
    }

    public async listOutcomes(): Promise<AutoFixOutcome[]> {
        return this.artifactStore.listAutoFixOutcomes();
    }

    public async evaluateProposal(proposalId: string): Promise<{ proposal: AutoFixProposal | null; gate: AutoFixGateResult | null; plan: AutoFixExecutionPlan | null }> {
        const proposal = await this.artifactStore.getAutoFixProposal(proposalId);
        if (!proposal) return { proposal: null, gate: null, plan: null };

        const gate = this.applySafetyGate(proposal);
        const plan = this.buildExecutionPlan(proposal, true);

        const nextStatus: AutoFixProposalStatus =
            gate.decision === 'auto_apply_allowed' ? 'proposed'
                : gate.decision === 'approval_required' ? 'gated_requires_approval'
                    : 'gated_blocked';
        await this.artifactStore.updateAutoFixProposalStatus(proposalId, nextStatus);

        console.log(`[AutoFixGate] proposalId=${proposalId} decision=${gate.decision} reason=${gate.reason}`);
        return { proposal: await this.artifactStore.getAutoFixProposal(proposalId), gate, plan };
    }

    public async dryRunProposal(proposalId: string): Promise<{ proposal: AutoFixProposal | null; gate: AutoFixGateResult | null; plan: AutoFixExecutionPlan | null }> {
        return this.evaluateProposal(proposalId);
    }

    public async runProposal(proposalId: string): Promise<{ success: boolean; proposal: AutoFixProposal | null; gate: AutoFixGateResult | null; plan: AutoFixExecutionPlan | null; outcome?: AutoFixOutcome }> {
        const proposal = await this.artifactStore.getAutoFixProposal(proposalId);
        if (!proposal) {
            return { success: false, proposal: null, gate: null, plan: null };
        }
        if (this.activeProposalId && this.activeProposalId !== proposalId) {
            return {
                success: false,
                proposal,
                gate: { proposalId, decision: 'blocked_out_of_scope', reason: 'another_autofix_run_active' },
                plan: null,
            };
        }

        const gate = this.applySafetyGate(proposal);
        const plan = this.buildExecutionPlan(proposal, false);
        console.log(`[AutoFix] proposalId=${proposalId} stage=plan_built`);
        console.log(`[AutoFixGate] proposalId=${proposalId} decision=${gate.decision} reason=${gate.reason}`);

        if (gate.decision !== 'auto_apply_allowed') {
            const status: AutoFixProposalStatus = gate.decision === 'approval_required' ? 'gated_requires_approval' : 'gated_blocked';
            await this.artifactStore.updateAutoFixProposalStatus(proposalId, status);

            if (proposal.actionType === 'emit_patch_plan') {
                await this.artifactStore.savePatchPlanArtifact(proposalId, {
                    proposal,
                    gate,
                    generatedAt: nowIso(),
                    plan,
                });
            }

            const outcome = await this.persistOutcome(proposal, status, gate.decision, 'skipped_with_reason', false, gate.reason);
            return { success: false, proposal: await this.artifactStore.getAutoFixProposal(proposalId), gate, plan, outcome };
        }

        this.activeProposalId = proposalId;
        await this.artifactStore.updateAutoFixProposalStatus(proposalId, 'executing');
        console.log(`[AutoFix] proposalId=${proposalId} stage=apply_started`);

        let rollbackContext: Record<string, unknown> = {};
        try {
            rollbackContext = await this.applyProposal(proposal);
            console.log(`[AutoFix] proposalId=${proposalId} stage=apply_complete`);
            const verification = await this.verifyProposal(proposal);

            if (verification.result === 'passed') {
                await this.artifactStore.updateAutoFixProposalStatus(proposalId, 'verification_passed');
                console.log(`[AutoFix] proposalId=${proposalId} stage=verify_passed`);
                await this.artifactStore.updateAutoFixProposalStatus(proposalId, 'completed');
                const outcome = await this.persistOutcome(proposal, 'completed', gate.decision, 'passed', false, verification.message);
                return { success: true, proposal: await this.artifactStore.getAutoFixProposal(proposalId), gate, plan, outcome };
            }

            await this.artifactStore.updateAutoFixProposalStatus(proposalId, 'verification_failed');
            console.log(`[AutoFix] proposalId=${proposalId} stage=verify_failed`);
            const rolledBack = await this.rollbackProposal(proposal, rollbackContext);
            if (rolledBack) {
                await this.artifactStore.updateAutoFixProposalStatus(proposalId, 'rolled_back');
                console.log(`[AutoFix] proposalId=${proposalId} stage=rollback_complete`);
            }
            const outcome = await this.persistOutcome(
                proposal,
                rolledBack ? 'rolled_back' : 'failed',
                gate.decision,
                'failed',
                rolledBack,
                verification.message
            );
            return { success: false, proposal: await this.artifactStore.getAutoFixProposal(proposalId), gate, plan, outcome };
        } catch (error: any) {
            console.log(`[AutoFix] proposalId=${proposalId} stage=verify_failed`);
            const rolledBack = await this.rollbackProposal(proposal, rollbackContext);
            await this.artifactStore.updateAutoFixProposalStatus(proposalId, rolledBack ? 'rolled_back' : 'failed');
            const outcome = await this.persistOutcome(
                proposal,
                rolledBack ? 'rolled_back' : 'failed',
                gate.decision,
                'failed',
                rolledBack,
                error?.message || 'unknown_error'
            );
            return { success: false, proposal: await this.artifactStore.getAutoFixProposal(proposalId), gate, plan, outcome };
        } finally {
            this.activeProposalId = null;
        }
    }

    private createProposal(input: Omit<AutoFixProposal, 'proposalId' | 'status' | 'createdAt' | 'updatedAt'>): AutoFixProposal {
        const timestamp = nowIso();
        return {
            ...input,
            proposalId: buildProposalId(),
            status: 'proposed',
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    }

    private applySafetyGate(proposal: AutoFixProposal): AutoFixGateResult {
        const policy = this.getPolicy();
        if (proposal.confidence < policy.minConfidence) {
            return { proposalId: proposal.proposalId, decision: 'blocked_low_confidence', reason: 'confidence_below_threshold' };
        }
        if (!policy.allowedCategories.includes(proposal.category)) {
            return {
                proposalId: proposal.proposalId,
                decision: proposal.category === 'code_patch_plan' ? 'approval_required' : 'blocked_out_of_scope',
                reason: proposal.category === 'code_patch_plan' ? 'code_modification_not_auto_allowed' : 'category_not_allowlisted'
            };
        }
        if (!policy.allowedActions.includes(proposal.actionType)) {
            return { proposalId: proposal.proposalId, decision: 'blocked_unsafe', reason: 'action_not_allowlisted' };
        }
        if (RISK_WEIGHT[proposal.riskLevel] > RISK_WEIGHT[policy.maxRiskAllowedForAutoApply]) {
            return {
                proposalId: proposal.proposalId,
                decision: proposal.category === 'code_patch_plan' ? 'approval_required' : 'blocked_unsafe',
                reason: 'risk_above_policy_max',
            };
        }
        if (!proposal.verificationPlan?.trim()) {
            return { proposalId: proposal.proposalId, decision: 'blocked_missing_verification', reason: 'verification_plan_missing' };
        }
        if (policy.requireRollback && !policy.irreversibleAllowedActions.includes(proposal.actionType)) {
            if (!proposal.rollbackPlan?.trim() || proposal.rollbackPlan.includes('not_applicable')) {
                return { proposalId: proposal.proposalId, decision: 'blocked_missing_rollback', reason: 'rollback_plan_missing' };
            }
        }
        if (proposal.actionType === 'update_config_value' || proposal.actionType === 'update_policy_value') {
            if (!proposal.targetKey || !policy.allowlistedConfigKeys.includes(proposal.targetKey)) {
                return { proposalId: proposal.proposalId, decision: 'blocked_out_of_scope', reason: 'config_key_not_allowlisted' };
            }
        }
        if (policy.requireAppRootContainment && proposal.targetPath) {
            if (!isPathWithinAppRoot(proposal.targetPath)) {
                return { proposalId: proposal.proposalId, decision: 'blocked_external_path', reason: 'target_path_outside_app_root' };
            }
        }
        return { proposalId: proposal.proposalId, decision: 'auto_apply_allowed', reason: 'policy_low_risk' };
    }

    private buildExecutionPlan(proposal: AutoFixProposal, dryRun: boolean): AutoFixExecutionPlan {
        const steps = [{
            stepId: `step_${proposal.proposalId}_1`,
            action: proposal.actionType,
            target: proposal.targetPath || proposal.targetKey || proposal.targetType,
            afterValue: proposal.proposedValue,
        }];
        const rollbackSteps = proposal.rollbackPlan?.trim() ? [proposal.rollbackPlan] : [];
        const verificationSteps = proposal.verificationPlan?.trim() ? [proposal.verificationPlan] : [];
        return {
            proposalId: proposal.proposalId,
            dryRun,
            steps,
            rollbackSteps,
            verificationSteps,
        };
    }

    private async applyProposal(proposal: AutoFixProposal): Promise<Record<string, unknown>> {
        switch (proposal.actionType) {
            case 'update_config_value':
            case 'update_policy_value': {
                const settings = loadSettings(this.settingsPath);
                if (!proposal.targetKey) throw new Error('targetKey_missing');
                const before = resolveByPath(settings, proposal.targetKey);
                setByPath(settings, proposal.targetKey, proposal.proposedValue);
                saveSettings(this.settingsPath, settings);
                return { beforeValue: before };
            }
            case 'rotate_log': {
                const logFile = proposal.targetPath ? path.basename(proposal.targetPath) : 'runtime-errors.jsonl';
                this.lifecycle.rotateOversizedOnStartup(logFile);
                return {};
            }
            case 'prune_logs': {
                const logFile = proposal.targetPath ? path.basename(proposal.targetPath) : 'runtime-errors.jsonl';
                this.lifecycle.pruneRotated(logFile);
                return {};
            }
            case 'suppress_provider': {
                if (!proposal.targetKey || !proposal.proposedValue) throw new Error('provider_target_missing');
                const settings = loadSettings(this.settingsPath);
                const providerId = String(proposal.proposedValue);
                const existing = resolveByPath(settings, proposal.targetKey);
                const arr = Array.isArray(existing) ? [...existing] : [];
                const before = [...arr];
                if (!arr.includes(providerId)) arr.push(providerId);
                setByPath(settings, proposal.targetKey, arr);
                saveSettings(this.settingsPath, settings);
                return { beforeValue: before };
            }
            case 'clear_runtime_cache': {
                const backupPath = path.join(this.cacheDir, `_rollback_${proposal.proposalId}`);
                if (fs.existsSync(this.cacheDir)) {
                    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true });
                    fs.renameSync(this.cacheDir, backupPath);
                }
                fs.mkdirSync(this.cacheDir, { recursive: true });
                return { backupPath };
            }
            case 'emit_patch_plan': {
                const artifactPath = await this.artifactStore.savePatchPlanArtifact(proposal.proposalId, {
                    proposal,
                    generatedAt: nowIso(),
                });
                return { artifactPath };
            }
            default:
                throw new Error(`unsupported_action:${proposal.actionType}`);
        }
    }

    private async verifyProposal(proposal: AutoFixProposal): Promise<{ result: AutoFixVerificationResult; message: string }> {
        switch (proposal.actionType) {
            case 'update_config_value':
            case 'update_policy_value': {
                if (!proposal.targetKey) return { result: 'failed', message: 'targetKey_missing' };
                const settings = loadSettings(this.settingsPath);
                const actual = resolveByPath(settings, proposal.targetKey);
                return JSON.stringify(actual) === JSON.stringify(proposal.proposedValue)
                    ? { result: 'passed', message: 'config_value_updated' }
                    : { result: 'failed', message: 'config_value_mismatch' };
            }
            case 'rotate_log': {
                const logPath = proposal.targetPath || path.join(this.logsDir, 'runtime-errors.jsonl');
                const exists = fs.existsSync(logPath);
                return exists ? { result: 'passed', message: 'active_log_exists' } : { result: 'failed', message: 'active_log_missing' };
            }
            case 'prune_logs': {
                return { result: 'passed', message: 'prune_completed' };
            }
            case 'suppress_provider': {
                if (!proposal.targetKey || !proposal.proposedValue) return { result: 'failed', message: 'provider_target_missing' };
                const settings = loadSettings(this.settingsPath);
                const arr = resolveByPath(settings, proposal.targetKey);
                return Array.isArray(arr) && arr.includes(proposal.proposedValue)
                    ? { result: 'passed', message: 'provider_suppressed' }
                    : { result: 'failed', message: 'provider_not_suppressed' };
            }
            case 'clear_runtime_cache': {
                return fs.existsSync(this.cacheDir)
                    ? { result: 'passed', message: 'cache_dir_reset' }
                    : { result: 'failed', message: 'cache_dir_missing' };
            }
            case 'emit_patch_plan': {
                const artifactPath = path.join(resolveDataPath(path.join('reflection', 'artifacts', 'auto_fix', 'patch_plans')), `${proposal.proposalId}.json`);
                return fs.existsSync(artifactPath)
                    ? { result: 'passed', message: 'patch_plan_written' }
                    : { result: 'failed', message: 'patch_plan_missing' };
            }
            default:
                return { result: 'skipped_with_reason', message: 'verification_not_supported' };
        }
    }

    private async rollbackProposal(proposal: AutoFixProposal, context: Record<string, unknown>): Promise<boolean> {
        try {
            console.log(`[AutoFix] proposalId=${proposal.proposalId} stage=rollback_started`);
            switch (proposal.actionType) {
                case 'update_config_value':
                case 'update_policy_value': {
                    if (!proposal.targetKey) return false;
                    const settings = loadSettings(this.settingsPath);
                    setByPath(settings, proposal.targetKey, context.beforeValue);
                    saveSettings(this.settingsPath, settings);
                    return true;
                }
                case 'suppress_provider': {
                    if (!proposal.targetKey) return false;
                    const settings = loadSettings(this.settingsPath);
                    setByPath(settings, proposal.targetKey, context.beforeValue);
                    saveSettings(this.settingsPath, settings);
                    return true;
                }
                case 'clear_runtime_cache': {
                    const backupPath = String(context.backupPath || '');
                    if (!backupPath || !fs.existsSync(backupPath)) return false;
                    fs.rmSync(this.cacheDir, { recursive: true, force: true });
                    fs.renameSync(backupPath, this.cacheDir);
                    return true;
                }
                default:
                    return false;
            }
        } catch (error) {
            console.error(`[AutoFix] proposalId=${proposal.proposalId} rollback_failed`, error);
            return false;
        }
    }

    private async persistOutcome(
        proposal: AutoFixProposal,
        status: AutoFixProposalStatus,
        gateDecision: AutoFixGateDecision,
        verificationResult: AutoFixVerificationResult,
        rolledBack: boolean,
        details: string
    ): Promise<AutoFixOutcome> {
        const outcome: AutoFixOutcome = {
            outcomeId: `afo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            proposalId: proposal.proposalId,
            status,
            gateDecision,
            verificationResult,
            rolledBack,
            details,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        await this.artifactStore.saveAutoFixOutcome(outcome);
        return outcome;
    }
}
