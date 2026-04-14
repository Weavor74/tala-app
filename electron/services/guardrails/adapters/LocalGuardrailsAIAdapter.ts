/**
 * LocalGuardrailsAIAdapter.ts
 *
 * Adapter for GuardrailsAI validators running locally via a Python subprocess.
 *
 * Engine: GuardrailsAI (https://guardrailsai.com/)
 *
 * Node.js (electron/) only.
 */

import fs from 'fs';
import { spawn } from 'child_process';
import type { ValidatorBinding } from '../../../../shared/guardrails/guardrailPolicyTypes';
import type {
    IGuardrailAdapter,
    GuardrailValidationRequest,
    GuardrailValidationResult,
    GuardrailViolation,
    GuardrailEvidence,
} from '../types';
import { makeErrorResult, makePassResult, makeViolationResult } from '../types';
import { APP_ROOT } from '../../PathResolver';
import { SystemService } from '../../SystemService';
import {
    resolveLocalGuardrailsPythonPath,
    resolveLocalGuardrailsRunnerPath,
} from '../LocalGuardrailsRuntime';

interface RawGuardrailsAIResult {
    passed: boolean;
    output?: string;
    error_message?: string;
    fixed_value?: string;
    validator_name: string;
}

interface RunnerInputPayload {
    validator_name: string;
    validator_args: Record<string, unknown>;
    content: string;
}

interface RunnerOutputEnvelope {
    ok: boolean;
    result?: Partial<RawGuardrailsAIResult>;
    error?: {
        code?: string;
        type?: string;
        message: string;
    };
}

/**
 * LocalGuardrailsAIAdapter
 *
 * Validates content using a GuardrailsAI Validator class running locally.
 * One validator class per binding (e.g. "ToxicLanguage", "DetectPII").
 */
export class LocalGuardrailsAIAdapter implements IGuardrailAdapter {
    readonly providerKind = 'local_guardrails_ai';
    private readonly _systemService = new SystemService();
    private _pythonPathPromise: Promise<string | undefined> | undefined;

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();
        try {
            const content = typeof request.content === 'string'
                ? request.content
                : JSON.stringify(request.content);

            const validatorName = binding.validatorName ?? 'UnknownValidator';
            const raw = await this._runGuardrailsValidator(
                validatorName,
                binding.validatorArgs ?? {},
                content,
                binding.timeoutMs ?? 10000,
            );

            const durationMs = Date.now() - start;

            if (raw.passed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'guardrails_ai_pass',
                    description: `Validator '${validatorName}' passed`,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `guardrails_ai:${validatorName}`,
                message: raw.error_message ?? `Validator '${validatorName}' failed`,
                fixedValue: raw.fixed_value,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'guardrails_ai_fail',
                description: `Validator '${validatorName}' detected a violation`,
                raw: raw as unknown as Record<string, unknown>,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /** Invoke the Guardrails runner subprocess and normalize the raw JSON result. */
    private async _runGuardrailsValidator(
        validatorName: string,
        args: Record<string, unknown>,
        content: string,
        timeoutMs: number,
    ): Promise<RawGuardrailsAIResult> {
        const pythonPath = await this._resolvePythonExecutable();
        if (!pythonPath) {
            throw new Error('No Python interpreter found for local_guardrails_ai adapter');
        }

        const runnerPath = this._resolveRunnerPath();
        if (!fs.existsSync(runnerPath)) {
            throw new Error(`Guardrails runner script not found at '${runnerPath}'`);
        }

        const payload: RunnerInputPayload = {
            validator_name: validatorName,
            validator_args: args,
            content,
        };

        return new Promise<RawGuardrailsAIResult>((resolve, reject) => {
            const child = spawn(pythonPath, [runnerPath], {
                cwd: APP_ROOT,
                stdio: 'pipe',
                env: this._systemService.getMcpEnv(process.env as Record<string, string>),
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            let timedOut = false;

            const finishError = (error: Error): void => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            const finishSuccess = (result: RawGuardrailsAIResult): void => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const timeoutHandle = setTimeout(() => {
                timedOut = true;
                child.kill();
                finishError(
                    new Error(
                        `Local Guardrails validator '${validatorName}' timed out after ${timeoutMs}ms`,
                    ),
                );
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
                finishError(
                    new Error(
                        `Unable to start Guardrails runner subprocess: ${err.message}`,
                    ),
                );
            });

            child.on('close', (code, signal) => {
                clearTimeout(timeoutHandle);
                if (timedOut) return;

                if (code !== 0) {
                    const details = stderr.trim() || `exit code ${code ?? 'unknown'}`;
                    finishError(
                        new Error(
                            `Guardrails runner failed (${signal ?? 'no-signal'}): ${details}`,
                        ),
                    );
                    return;
                }

                const trimmed = stdout.trim();
                if (!trimmed) {
                    finishError(new Error('Guardrails runner returned empty stdout'));
                    return;
                }

                let envelope: RunnerOutputEnvelope;
                try {
                    envelope = JSON.parse(trimmed) as RunnerOutputEnvelope;
                } catch {
                    finishError(new Error('Guardrails runner returned malformed JSON'));
                    return;
                }

                if (!envelope.ok) {
                    const error = envelope.error;
                    const codeText = error?.code ? `[${error.code}] ` : '';
                    const typeText = error?.type ? `(${error.type}) ` : '';
                    const message = error?.message ?? 'Runner reported unknown error';
                    finishError(
                        new Error(`Guardrails runner error ${codeText}${typeText}${message}`.trim()),
                    );
                    return;
                }

                if (!envelope.result) {
                    finishError(new Error('Guardrails runner JSON missing result payload'));
                    return;
                }

                try {
                    finishSuccess(this._normalizeRunnerResult(validatorName, envelope.result));
                } catch (err) {
                    finishError(err as Error);
                }
            });

            try {
                child.stdin.write(JSON.stringify(payload));
                child.stdin.end();
            } catch (err) {
                clearTimeout(timeoutHandle);
                child.kill();
                finishError(
                    new Error(
                        `Failed to write request payload to Guardrails runner: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    ),
                );
            }
        });
    }

    private _normalizeRunnerResult(
        fallbackValidatorName: string,
        result: Partial<RawGuardrailsAIResult>,
    ): RawGuardrailsAIResult {
        if (typeof result.passed !== 'boolean') {
            throw new Error('Guardrails runner JSON missing boolean field: result.passed');
        }

        return {
            passed: result.passed,
            validator_name: result.validator_name ?? fallbackValidatorName,
            output: typeof result.output === 'string' ? result.output : undefined,
            error_message:
                typeof result.error_message === 'string'
                    ? result.error_message
                    : undefined,
            fixed_value:
                typeof result.fixed_value === 'string' ? result.fixed_value : undefined,
        };
    }

    private _resolveRunnerPath(): string {
        return resolveLocalGuardrailsRunnerPath(APP_ROOT);
    }

    private async _resolvePythonExecutable(): Promise<string | undefined> {
        if (!this._pythonPathPromise) {
            this._pythonPathPromise = this._resolvePythonExecutableOnce();
        }
        return this._pythonPathPromise;
    }

    private async _resolvePythonExecutableOnce(): Promise<string | undefined> {
        return resolveLocalGuardrailsPythonPath(this._systemService, APP_ROOT);
    }
}

/** Shared singleton. */
export const localGuardrailsAIAdapter = new LocalGuardrailsAIAdapter();
