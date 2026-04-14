import fs from 'fs';
import { spawn } from 'child_process';
import type { LocalGuardrailsRuntimeReadiness } from '../../../shared/guardrails/localGuardrailsRuntimeTypes';
import { SystemService } from '../SystemService';
import { APP_ROOT } from '../PathResolver';
import {
    resolveLocalGuardrailsPythonPath,
    resolveLocalGuardrailsRunnerPath,
} from './LocalGuardrailsRuntime';

interface RunnerHealthEnvelope {
    ok: boolean;
    health?: {
        guardrails_importable?: boolean;
        guardrails_version?: string;
        python_version?: string;
        error?: string;
    };
    error?: {
        code?: string;
        type?: string;
        message?: string;
    };
}

interface LocalGuardrailsRuntimeHealthDeps {
    resolvePythonPath?: () => Promise<string | undefined>;
    resolveRunnerPath?: () => string;
    fileExists?: (filePath: string) => boolean;
    spawnProcess?: typeof spawn;
    systemService?: SystemService;
}

export class LocalGuardrailsRuntimeHealth {
    private readonly _systemService: SystemService;
    private readonly _resolvePythonPath: () => Promise<string | undefined>;
    private readonly _resolveRunnerPath: () => string;
    private readonly _fileExists: (filePath: string) => boolean;
    private readonly _spawnProcess: typeof spawn;

    constructor(deps: LocalGuardrailsRuntimeHealthDeps = {}) {
        this._systemService = deps.systemService ?? new SystemService();
        this._resolvePythonPath = deps.resolvePythonPath
            ?? (() => resolveLocalGuardrailsPythonPath(this._systemService, APP_ROOT));
        this._resolveRunnerPath = deps.resolveRunnerPath
            ?? (() => resolveLocalGuardrailsRunnerPath(APP_ROOT));
        this._fileExists = deps.fileExists ?? fs.existsSync;
        this._spawnProcess = deps.spawnProcess ?? spawn;
    }

    async checkReadiness(timeoutMs: number = 5000): Promise<LocalGuardrailsRuntimeReadiness> {
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
            return base;
        }

        if (!runnerExists) {
            return {
                ...base,
                guardrails: {
                    importable: false,
                    error: `Runner not found at '${runnerPath}'`,
                },
            };
        }

        const healthEnvelope = await this._runHealthCheck(pythonPath!, runnerPath, timeoutMs);
        if (!healthEnvelope.ok) {
            const message = healthEnvelope.error?.message ?? 'Runner health check failed';
            return {
                ...base,
                guardrails: {
                    importable: false,
                    error: message,
                },
            };
        }

        const importable = Boolean(healthEnvelope.health?.guardrails_importable);
        return {
            ...base,
            ready: importable,
            guardrails: {
                importable,
                version: healthEnvelope.health?.guardrails_version,
                pythonVersion: healthEnvelope.health?.python_version,
                error: healthEnvelope.health?.error,
            },
        };
    }

    private async _runHealthCheck(
        pythonPath: string,
        runnerPath: string,
        timeoutMs: number,
    ): Promise<RunnerHealthEnvelope> {
        return new Promise<RunnerHealthEnvelope>((resolve) => {
            const child = this._spawnProcess(pythonPath, [runnerPath, '--health'], {
                cwd: APP_ROOT,
                stdio: 'pipe',
                env: this._systemService.getMcpEnv(process.env as Record<string, string>),
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
