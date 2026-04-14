import fs from 'fs';
import { spawn } from 'child_process';
import type { LocalGuardrailsRuntimeReadiness } from '../../../shared/guardrails/localGuardrailsRuntimeTypes';
import { SystemService } from '../SystemService';
import { APP_ROOT } from '../PathResolver';
import {
    buildLocalGuardrailsPythonEnv,
    resolveLocalGuardrailsPythonPath,
    resolveLocalGuardrailsRunnerPath,
} from './LocalGuardrailsRuntime';
import { guardrailsTelemetry, type IGuardrailsTelemetry } from './GuardrailsTelemetry';

interface RunnerHealthEnvelope {
    ok: boolean;
    health?: {
        guardrails_importable?: boolean;
        guardrails_version?: string;
        python_version?: string;
        diagnostics?: RunnerHealthDiagnostics;
        error?: string;
    };
    error?: {
        code?: string;
        type?: string;
        message?: string;
    };
}

interface RunnerHealthDiagnostics {
    sys_executable?: string;
    sys_version?: string;
    cwd?: string;
    sys_path?: string[];
    pythonhome?: string | null;
    pythonpath?: string | null;
    guardrails_import_succeeded?: boolean;
    guardrails_import_error?: string;
}

function normalizeDiagnostics(
    diagnostics: RunnerHealthDiagnostics | undefined,
): LocalGuardrailsRuntimeReadiness['guardrails']['diagnostics'] | undefined {
    if (!diagnostics) return undefined;
    return {
        sysExecutable: diagnostics.sys_executable,
        sysVersion: diagnostics.sys_version,
        cwd: diagnostics.cwd,
        sysPath: diagnostics.sys_path,
        pythonhome: diagnostics.pythonhome ?? undefined,
        pythonpath: diagnostics.pythonpath ?? undefined,
        guardrailsImportSucceeded: diagnostics.guardrails_import_succeeded,
        guardrailsImportError: diagnostics.guardrails_import_error,
    };
}

interface LocalGuardrailsRuntimeHealthDeps {
    resolvePythonPath?: () => Promise<string | undefined>;
    resolveRunnerPath?: () => string;
    fileExists?: (filePath: string) => boolean;
    spawnProcess?: typeof spawn;
    systemService?: SystemService;
    telemetry?: IGuardrailsTelemetry;
}

export class LocalGuardrailsRuntimeHealth {
    private readonly _systemService: SystemService;
    private readonly _resolvePythonPath: () => Promise<string | undefined>;
    private readonly _resolveRunnerPath: () => string;
    private readonly _fileExists: (filePath: string) => boolean;
    private readonly _spawnProcess: typeof spawn;
    private readonly _telemetry: IGuardrailsTelemetry;

    constructor(deps: LocalGuardrailsRuntimeHealthDeps = {}) {
        this._systemService = deps.systemService ?? new SystemService();
        this._resolvePythonPath = deps.resolvePythonPath
            ?? (() => resolveLocalGuardrailsPythonPath(this._systemService, APP_ROOT));
        this._resolveRunnerPath = deps.resolveRunnerPath
            ?? (() => resolveLocalGuardrailsRunnerPath(APP_ROOT));
        this._fileExists = deps.fileExists ?? fs.existsSync;
        this._spawnProcess = deps.spawnProcess ?? spawn;
        this._telemetry = deps.telemetry ?? guardrailsTelemetry;
    }

    async checkReadiness(timeoutMs: number = 5000): Promise<LocalGuardrailsRuntimeReadiness> {
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();
        const runnerPath = this._resolveRunnerPath();
        const runnerExists = this._fileExists(runnerPath);

        const pythonPath = await this._resolvePythonPath();
        const pythonResolved = Boolean(pythonPath);

        const base: LocalGuardrailsRuntimeReadiness = {
            providerKind: 'local_guardrails_ai',
            checkedAt,
            ready: false,
            python: {
                resolved: pythonResolved,
                path: pythonPath,
                error: pythonResolved ? undefined : 'Python interpreter not found',
            },
            runner: {
                path: runnerPath,
                exists: runnerExists,
            },
            guardrails: {
                importable: false,
            },
        };

        if (!pythonResolved) {
            this._emitHealthEvent(base, {
                status: 'blocked',
                code: 'PYTHON_UNRESOLVED',
                reason: base.python.error,
                fixHint: 'Install or configure a local Python runtime in the app root.',
                startedAt,
            });
            return base;
        }

        if (!runnerExists) {
            const result = {
                ...base,
                guardrails: {
                    importable: false,
                    error: `Runner not found at '${runnerPath}'`,
                },
            };
            this._emitHealthEvent(result, {
                status: 'blocked',
                code: 'RUNNER_MISSING',
                reason: result.guardrails.error,
                fixHint: 'Ensure runtime/guardrails/local_guardrails_runner.py exists in the app root/package.',
                startedAt,
            });
            return result;
        }

        const healthEnvelope = await this._runHealthCheck(pythonPath!, runnerPath, timeoutMs);
        if (!healthEnvelope.ok) {
            const message = healthEnvelope.error?.message ?? 'Runner health check failed';
            const result = {
                ...base,
                guardrails: {
                    importable: false,
                    error: message,
                    diagnostics: normalizeDiagnostics(healthEnvelope.health?.diagnostics),
                },
            };
            this._emitHealthEvent(result, {
                status: 'failed',
                code: healthEnvelope.error?.code,
                reason: message,
                fixHint: this._fixHintForError(message),
                startedAt,
            });
            return result;
        }

        const importable = Boolean(healthEnvelope.health?.guardrails_importable);
        const result = {
            ...base,
            ready: importable,
            guardrails: {
                importable,
                version: healthEnvelope.health?.guardrails_version,
                pythonVersion: healthEnvelope.health?.python_version,
                error: healthEnvelope.health?.error,
                diagnostics: normalizeDiagnostics(healthEnvelope.health?.diagnostics),
            },
        };
        this._emitHealthEvent(result, {
            status: importable ? 'ready' : 'blocked',
            reason: result.guardrails.error,
            code: importable ? 'RUNTIME_READY' : 'GUARDRAILS_IMPORT_FAILED',
            fixHint: importable ? undefined : this._fixHintForError(result.guardrails.error),
            startedAt,
        });
        return result;
    }

    private _fixHintForError(message: string | undefined): string | undefined {
        const text = (message ?? '').toLowerCase();
        if (!text) return undefined;
        if (text.includes('python')) return 'Install or configure a local Python interpreter in the app root.';
        if (text.includes('runner not found')) return 'Ensure runtime/guardrails/local_guardrails_runner.py is packaged and present.';
        if (text.includes('no module named guardrails') || text.includes('guardrails')) {
            return 'Install guardrails-ai in the selected local Python environment.';
        }
        return undefined;
    }

    private _emitHealthEvent(
        readiness: LocalGuardrailsRuntimeReadiness,
        input: {
            status: 'ready' | 'degraded' | 'blocked' | 'failed' | 'passed';
            code?: string;
            reason?: string;
            fixHint?: string;
            startedAt: number;
        },
    ): void {
        const diagnostics = readiness.guardrails.diagnostics;
        this._telemetry.emit({
            eventName: 'guardrails.runtime.health',
            actor: 'LocalGuardrailsRuntimeHealth',
            summary: readiness.ready
                ? 'Local guardrails runtime readiness check succeeded.'
                : 'Local guardrails runtime readiness check failed.',
            status: input.status,
            payload: {
                providerKind: readiness.providerKind,
                runnerPath: readiness.runner.path,
                pythonExecutable: diagnostics?.sysExecutable ?? readiness.python.path,
                importError: diagnostics?.guardrailsImportError ?? readiness.guardrails.error,
                fixHint: input.fixHint,
                reason: input.reason,
                code: input.code,
                durationMs: Date.now() - input.startedAt,
                diagnostics,
            },
        });
    }

    private async _runHealthCheck(
        pythonPath: string,
        runnerPath: string,
        timeoutMs: number,
    ): Promise<RunnerHealthEnvelope> {
        return new Promise<RunnerHealthEnvelope>((resolve) => {
            const env = buildLocalGuardrailsPythonEnv(process.env);
            console.info(
                `[LocalGuardrailsRuntimeHealth] Spawning runner with python="${pythonPath}" runner="${runnerPath}" ` +
                `cwd="${APP_ROOT}" PYTHONHOME="${env.PYTHONHOME ?? ''}" PYTHONPATH="${env.PYTHONPATH ?? ''}"`,
            );
            const child = this._spawnProcess(pythonPath, [runnerPath, '--health'], {
                cwd: APP_ROOT,
                stdio: 'pipe',
                env,
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const finish = (value: RunnerHealthEnvelope) => {
                resolve(value);
            };

            const timeoutHandle = setTimeout(() => {
                timedOut = true;
                child.kill();
                finish({
                    ok: false,
                    error: {
                        code: 'RUNNER_TIMEOUT',
                        message: `Guardrails health check timed out after ${timeoutMs}ms`,
                    },
                });
            }, timeoutMs);

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');

            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });

            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });

            child.on('error', (err) => {
                clearTimeout(timeoutHandle);
                finish({
                    ok: false,
                    error: {
                        code: 'SPAWN_ERROR',
                        message: `Failed to start Guardrails health check: ${err.message}`,
                    },
                });
            });

            child.on('close', (code) => {
                clearTimeout(timeoutHandle);
                if (timedOut) return;

                if (code !== 0) {
                    finish({
                        ok: false,
                        error: {
                            code: 'RUNNER_EXIT_NONZERO',
                            message: stderr.trim() || `Runner exited with code ${code}`,
                        },
                    });
                    return;
                }

                const trimmed = stdout.trim();
                if (!trimmed) {
                    finish({
                        ok: false,
                        error: {
                            code: 'RUNNER_EMPTY_STDOUT',
                            message: 'Runner returned empty stdout',
                        },
                    });
                    return;
                }

                try {
                    finish(JSON.parse(trimmed) as RunnerHealthEnvelope);
                } catch {
                    finish({
                        ok: false,
                        error: {
                            code: 'RUNNER_BAD_JSON',
                            message: 'Runner returned malformed JSON',
                        },
                    });
                }
            });
        });
    }
}

export const localGuardrailsRuntimeHealth = new LocalGuardrailsRuntimeHealth();
