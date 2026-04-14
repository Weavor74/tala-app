import type {
    GuardrailPolicyConfig,
    GuardrailProfile,
    GuardrailRule,
    ValidatorBinding,
    ValidatorProviderKind,
} from '../../../shared/guardrails/guardrailPolicyTypes';
import { normalizeGuardrailPolicyConfig } from '../../../shared/guardrails/guardrailPolicyTypes';
import type { GuardrailValidationResult } from './types';
import type {
    GuardrailPreflightBindingStatus,
    GuardrailPreflightProviderStatus,
    GuardrailProfilePreflightResult,
} from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';
import { localGuardrailsRuntimeHealth, type LocalGuardrailsRuntimeHealth } from './LocalGuardrailsRuntimeHealth';
import {
    localGuardrailsBindingProbeService,
    type LocalGuardrailsBindingProbeService,
} from './LocalGuardrailsBindingProbeService';
import { localGuardrailsPreflightSnapshotStore, type ILocalGuardrailsPreflightSnapshotStore } from './LocalGuardrailsPreflightSnapshotStore';
import { resolveLocalGuardrailsPythonPath } from './LocalGuardrailsRuntime';
import { SystemService } from '../SystemService';
import { spawn, type ChildProcess } from 'child_process';
import { guardrailsTelemetry, type IGuardrailsTelemetry } from './GuardrailsTelemetry';

interface LocalGuardrailsProfilePreflightInput {
    policy: GuardrailPolicyConfig;
    profileId: string;
    runProbe?: boolean;
    sampleContent?: string;
}

interface LocalGuardrailsProfilePreflightDeps {
    runtimeHealth?: Pick<LocalGuardrailsRuntimeHealth, 'checkReadiness'>;
    probeService?: Pick<LocalGuardrailsBindingProbeService, 'testBinding'>;
    snapshotStore?: ILocalGuardrailsPreflightSnapshotStore;
    resolvePythonPath?: () => Promise<string | undefined>;
    checkPythonImport?: (pythonPath: string, moduleName: string) => Promise<{ ok: boolean; message?: string }>;
    checkLocalOPA?: () => Promise<{ ok: boolean; message?: string }>;
    spawnProcess?: typeof spawn;
    systemService?: SystemService;
    telemetry?: IGuardrailsTelemetry;
}

const REMOTE_PROVIDER_PREFIX = 'remote_';

export class LocalGuardrailsProfilePreflightService {
    private readonly _runtimeHealth: Pick<LocalGuardrailsRuntimeHealth, 'checkReadiness'>;
    private readonly _probeService: Pick<LocalGuardrailsBindingProbeService, 'testBinding'>;
    private readonly _snapshotStore: ILocalGuardrailsPreflightSnapshotStore;
    private readonly _resolvePythonPath: () => Promise<string | undefined>;
    private readonly _checkPythonImport: (pythonPath: string, moduleName: string) => Promise<{ ok: boolean; message?: string }>;
    private readonly _checkLocalOPA: () => Promise<{ ok: boolean; message?: string }>;
    private readonly _spawnProcess: typeof spawn;
    private readonly _systemService: SystemService;
    private readonly _telemetry: IGuardrailsTelemetry;

    constructor(deps: LocalGuardrailsProfilePreflightDeps = {}) {
        this._runtimeHealth = deps.runtimeHealth ?? localGuardrailsRuntimeHealth;
        this._probeService = deps.probeService ?? localGuardrailsBindingProbeService;
        this._snapshotStore = deps.snapshotStore ?? localGuardrailsPreflightSnapshotStore;
        this._systemService = deps.systemService ?? new SystemService();
        this._spawnProcess = deps.spawnProcess ?? spawn;
        this._resolvePythonPath = deps.resolvePythonPath
            ?? (() => resolveLocalGuardrailsPythonPath(this._systemService));
        this._checkPythonImport = deps.checkPythonImport
            ?? ((pythonPath: string, moduleName: string) => this._checkPythonModuleImport(pythonPath, moduleName));
        this._checkLocalOPA = deps.checkLocalOPA
            ?? (() => this._checkOPAAvailable());
        this._telemetry = deps.telemetry ?? guardrailsTelemetry;
    }

    async runProfilePreflight(
        input: LocalGuardrailsProfilePreflightInput,
    ): Promise<GuardrailProfilePreflightResult> {
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();
        const policy = normalizeGuardrailPolicyConfig(input.policy);
        const profile = policy.profiles.find(p => p.id === input.profileId);
        if (!profile) {
            return this._finalizeAndPersist(checkedAt, input.profileId, [], [], [
                `Profile '${input.profileId}' was not found`,
            ], startedAt);
        }

        const rules = this._resolveProfileRules(policy, profile);
        const bindings = this._resolveProfileBindings(rules);
        if (bindings.length === 0) {
            return this._finalizeAndPersist(checkedAt, profile.id, [], [], [], startedAt);
        }

        const providers = await this._evaluateProviders(bindings);
        const providerMap = new Map(providers.map(p => [p.providerKind, p]));
        const bindingStatuses: GuardrailPreflightBindingStatus[] = [];

        for (const { rule, binding } of bindings) {
            const provider = providerMap.get(binding.providerKind)!;
            bindingStatuses.push(await this._evaluateBinding({
                provider,
                binding,
                rule,
                runProbe: input.runProbe ?? true,
                sampleContent: input.sampleContent ?? 'Preflight probe content',
            }));
        }

        const issues: string[] = [
            ...providers.filter(p => p.status !== 'ready').map(p => p.message).filter(Boolean) as string[],
            ...bindingStatuses.filter(b => b.status !== 'ready').map(b => b.message).filter(Boolean) as string[],
        ];

        return this._finalizeAndPersist(checkedAt, profile.id, providers, bindingStatuses, issues, startedAt);
    }

    private _resolveProfileRules(
        policy: GuardrailPolicyConfig,
        profile: GuardrailProfile,
    ): GuardrailRule[] {
        const byId = new Map(policy.rules.map(rule => [rule.id, rule]));
        return profile.ruleIds
            .map(ruleId => byId.get(ruleId))
            .filter((rule): rule is GuardrailRule => Boolean(rule));
    }

    private _resolveProfileBindings(
        rules: GuardrailRule[],
    ): Array<{ rule: GuardrailRule; binding: ValidatorBinding }> {
        const resolved: Array<{ rule: GuardrailRule; binding: ValidatorBinding }> = [];
        for (const rule of rules) {
            for (const binding of rule.validatorBindings ?? []) {
                if (!binding.enabled) continue;
                resolved.push({ rule, binding });
            }
        }
        return resolved;
    }

    private async _evaluateProviders(
        bindings: Array<{ rule: GuardrailRule; binding: ValidatorBinding }>,
    ): Promise<GuardrailPreflightProviderStatus[]> {
        const kinds = [...new Set(bindings.map(item => item.binding.providerKind))];
        const providers: GuardrailPreflightProviderStatus[] = [];

        for (const providerKind of kinds) {
            providers.push(await this._evaluateProvider(providerKind));
        }

        return providers;
    }

    private async _evaluateProvider(
        providerKind: ValidatorProviderKind,
    ): Promise<GuardrailPreflightProviderStatus> {
        if (providerKind === 'local_guardrails_ai') {
            const readiness = await this._runtimeHealth.checkReadiness();
            if (readiness.ready) {
                return {
                    providerKind,
                    status: 'ready',
                    ready: true,
                };
            }
            const message = readiness.guardrails.error ?? readiness.python.error ?? 'local_guardrails_ai runtime not ready';
            return {
                providerKind,
                status: 'degraded',
                ready: false,
                message,
                fixHint: this._fixHintForMessage(providerKind, message),
            };
        }

        if (providerKind === 'local_presidio') {
            return this._evaluatePythonProvider(providerKind, 'presidio_analyzer');
        }

        if (providerKind === 'local_nemo_guardrails') {
            return this._evaluatePythonProvider(providerKind, 'nemoguardrails');
        }

        if (providerKind === 'local_opa') {
            const opa = await this._checkLocalOPA();
            if (opa.ok) {
                return {
                    providerKind,
                    status: 'ready',
                    ready: true,
                };
            }
            const message = opa.message ?? 'OPA runtime not available';
            return {
                providerKind,
                status: 'degraded',
                ready: false,
                message,
                fixHint: this._fixHintForMessage(providerKind, message),
            };
        }

        if (providerKind.startsWith(REMOTE_PROVIDER_PREFIX)) {
            return {
                providerKind,
                status: 'blocked',
                ready: false,
                message: `Provider '${providerKind}' is remote; local-only preflight cannot validate remote runtimes`,
                fixHint: 'Use a local provider for local-first preflight, or keep this binding disabled in local profiles.',
            };
        }

        return {
            providerKind,
            status: 'degraded',
            ready: false,
            message: `Provider '${providerKind}' has no local preflight health checker yet`,
            fixHint: this._fixHintForMessage(providerKind, `Provider '${providerKind}' has no local preflight health checker yet`),
        };
    }

    private async _evaluatePythonProvider(
        providerKind: ValidatorProviderKind,
        moduleName: string,
    ): Promise<GuardrailPreflightProviderStatus> {
        const pythonPath = await this._resolvePythonPath();
        if (!pythonPath) {
            const message = 'Python interpreter not found';
            return {
                providerKind,
                status: 'degraded',
                ready: false,
                message,
                fixHint: this._fixHintForMessage(providerKind, message),
            };
        }

        const importResult = await this._checkPythonImport(pythonPath, moduleName);
        if (!importResult.ok) {
            const message = importResult.message ?? `Missing Python module '${moduleName}'`;
            return {
                providerKind,
                status: 'degraded',
                ready: false,
                message,
                fixHint: this._fixHintForMessage(providerKind, message),
            };
        }

        return {
            providerKind,
            status: 'ready',
            ready: true,
        };
    }

    private async _evaluateBinding(input: {
        provider: GuardrailPreflightProviderStatus;
        binding: ValidatorBinding;
        rule: GuardrailRule;
        runProbe: boolean;
        sampleContent: string;
    }): Promise<GuardrailPreflightBindingStatus> {
        const { provider, binding, rule, runProbe, sampleContent } = input;
        const base: GuardrailPreflightBindingStatus = {
            bindingId: binding.id,
            bindingName: binding.name,
            providerKind: binding.providerKind,
            ruleId: rule.id,
            ruleName: rule.name,
            failOpen: binding.failOpen,
            status: 'ready',
            probe: { attempted: false },
        };

        if (!provider.ready) {
            return {
                ...base,
                status: binding.failOpen ? 'degraded' : 'blocked',
                message: provider.message ?? `Provider '${provider.providerKind}' is not ready`,
                fixHint: provider.fixHint,
            };
        }

        if (binding.providerKind !== 'local_guardrails_ai' || !runProbe) {
            return base;
        }

        const probeResult = await this._probeService.testBinding({
            binding,
            sampleContent,
        });

        return this._bindingFromProbe(base, probeResult);
    }

    private _bindingFromProbe(
        base: GuardrailPreflightBindingStatus,
        probeResult: GuardrailValidationResult,
    ): GuardrailPreflightBindingStatus {
        if (probeResult.success) {
            return {
                ...base,
                status: 'ready',
                probe: {
                    attempted: true,
                    success: true,
                    passed: probeResult.passed,
                },
            };
        }

        const failOpen = base.failOpen;
        return {
            ...base,
            status: failOpen ? 'degraded' : 'blocked',
            message: probeResult.error ?? 'Probe failed',
            fixHint: this._fixHintForMessage(base.providerKind, probeResult.error ?? 'Probe failed'),
            probe: {
                attempted: true,
                success: false,
                error: probeResult.error ?? 'Probe failed',
            },
        };
    }

    private _finalizeAndPersist(
        checkedAt: string,
        profileId: string,
        providers: GuardrailPreflightProviderStatus[],
        bindings: GuardrailPreflightBindingStatus[],
        issues: string[],
        startedAt: number,
    ): GuardrailProfilePreflightResult {
        const result = this._finalize(
            checkedAt,
            profileId,
            providers,
            bindings,
            issues,
        );
        this._snapshotStore.appendSnapshot(result);
        this._telemetry.emit({
            eventName: 'guardrails.preflight',
            actor: 'LocalGuardrailsProfilePreflightService',
            summary: `Guardrails profile preflight completed with status '${result.status}'.`,
            status: result.status,
            payload: {
                profileId: result.profileId,
                reason: result.issues[0],
                code: result.status === 'ready' ? 'PREFLIGHT_READY' : 'PREFLIGHT_NOT_READY',
                durationMs: Date.now() - startedAt,
                providerStatuses: result.providers.map(provider => ({
                    providerKind: provider.providerKind,
                    status: provider.status,
                    fixHint: provider.fixHint,
                    reason: provider.message,
                })),
                bindingStatuses: result.bindings.map(binding => ({
                    bindingId: binding.bindingId,
                    ruleId: binding.ruleId,
                    providerKind: binding.providerKind,
                    status: binding.status,
                    failOpen: binding.failOpen,
                    fixHint: binding.fixHint,
                    reason: binding.message,
                })),
                summary: result.summary,
                issues: result.issues,
            },
        });
        return result;
    }

    private _finalize(
        checkedAt: string,
        profileId: string,
        providers: GuardrailPreflightProviderStatus[],
        bindings: GuardrailPreflightBindingStatus[],
        issues: string[],
    ): GuardrailProfilePreflightResult {
        const summary = {
            providersTotal: providers.length,
            providersReady: providers.filter(p => p.status === 'ready').length,
            providersDegraded: providers.filter(p => p.status === 'degraded').length,
            providersBlocked: providers.filter(p => p.status === 'blocked').length,
            bindingsTotal: bindings.length,
            bindingsReady: bindings.filter(b => b.status === 'ready').length,
            bindingsDegraded: bindings.filter(b => b.status === 'degraded').length,
            bindingsBlocked: bindings.filter(b => b.status === 'blocked').length,
        };

        const status =
            summary.bindingsBlocked > 0
                ? 'blocked'
                : (summary.bindingsDegraded > 0 || summary.providersBlocked > 0 || summary.providersDegraded > 0)
                    ? 'degraded'
                    : 'ready';

        return {
            checkedAt,
            profileId,
            status,
            providers,
            bindings,
            summary,
            issues,
        };
    }

    private _fixHintForMessage(
        providerKind: ValidatorProviderKind,
        message: string | undefined,
    ): string | undefined {
        const text = (message ?? '').toLowerCase();
        if (!text) return undefined;

        if (text.includes('python interpreter not found') || text.includes('python missing')) {
            return 'Install or configure a project-local Python runtime in the app root (for example .venv, venv, or local-inference/venv).';
        }
        if (text.includes('runner not found')) {
            return 'Ensure runtime/guardrails/local_guardrails_runner.py is present in the app root and packaged build.';
        }
        if (text.includes('no module named guardrails') || text.includes('guardrails')) {
            return 'Install the Guardrails package in the resolved local Python environment (for example: pip install guardrails-ai).';
        }
        if (providerKind === 'local_presidio' && text.includes('presidio_analyzer')) {
            return 'Install Presidio dependencies in the local Python environment (for example: pip install presidio-analyzer).';
        }
        if (providerKind === 'local_nemo_guardrails' && text.includes('nemoguardrails')) {
            return 'Install NeMo Guardrails in the local Python environment (for example: pip install nemoguardrails).';
        }
        if (providerKind === 'local_opa' && text.includes('opa')) {
            return 'Install OPA and make sure the `opa` command is available on PATH, then start a local OPA server if required.';
        }
        if (text.includes('no local preflight health checker')) {
            return 'Use a supported local provider or add a provider readiness checker for this engine.';
        }
        return undefined;
    }

    private async _checkPythonModuleImport(
        pythonPath: string,
        moduleName: string,
    ): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve) => {
            const child = this._spawnProcess(
                pythonPath,
                ['-c', `import ${moduleName}`],
                {
                    stdio: 'pipe',
                    env: this._systemService.getMcpEnv(process.env as Record<string, string>),
                },
            );
            let settled = false;
            const finish = (value: { ok: boolean; message?: string }) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const timeoutHandle = setTimeout(() => {
                child.kill();
                finish({ ok: false, message: `Timed out importing ${moduleName}` });
            }, 3000);

            let stderr = '';
            let stdout = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', (err) => {
                clearTimeout(timeoutHandle);
                finish({ ok: false, message: err.message });
            });
            child.on('close', (code) => {
                clearTimeout(timeoutHandle);
                if (code === 0) {
                    finish({ ok: true });
                    return;
                }
                finish({
                    ok: false,
                    message: (stderr || stdout || `Module import failed: ${moduleName}`).trim(),
                });
            });
        });
    }

    private async _checkOPAAvailable(): Promise<{ ok: boolean; message?: string }> {
        return new Promise((resolve) => {
            const child = this._spawnProcess('opa', ['version'], { stdio: 'pipe' });
            let settled = false;
            const finish = (value: { ok: boolean; message?: string }) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const timeoutHandle = setTimeout(() => {
                child.kill();
                finish({ ok: false, message: 'Timed out checking OPA availability' });
            }, 3000);
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', (err) => {
                clearTimeout(timeoutHandle);
                finish({ ok: false, message: err.message });
            });
            child.on('close', (code) => {
                clearTimeout(timeoutHandle);
                if (code === 0) {
                    finish({ ok: true });
                    return;
                }
                finish({ ok: false, message: (stderr || 'opa command unavailable').trim() });
            });
        });
    }
}

export const localGuardrailsProfilePreflightService = new LocalGuardrailsProfilePreflightService();
