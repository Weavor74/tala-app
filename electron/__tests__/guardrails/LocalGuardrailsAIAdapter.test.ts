import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import type { ValidatorBinding } from '../../../shared/guardrails/guardrailPolicyTypes';
import type { GuardrailValidationRequest } from '../../services/guardrails/types';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { LocalGuardrailsAIAdapter } from '../../services/guardrails/adapters/LocalGuardrailsAIAdapter';

type MockChildProcess = ChildProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
    const child = new EventEmitter() as MockChildProcess;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    return child;
}

function makeBinding(overrides: Partial<ValidatorBinding> = {}): ValidatorBinding {
    return {
        id: 'binding-1',
        name: 'Local Guardrails',
        providerKind: 'local_guardrails_ai',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        validatorName: 'ToxicLanguage',
        validatorArgs: {},
        failOpen: false,
        priority: 1,
        timeoutMs: 1000,
        ...overrides,
    };
}

function makeRequest(): GuardrailValidationRequest {
    return {
        content: 'hello world',
        executionId: 'exec-1',
        executionType: 'chat_turn',
        executionOrigin: 'kernel',
        executionMode: 'assistant',
    };
}

describe('LocalGuardrailsAIAdapter', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        vi.useRealTimers();
    });

    it('returns pass result on subprocess success', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        const runnerPath = path.join(process.cwd(), 'runtime', 'guardrails', 'local_guardrails_runner.py');
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue('python-local');
        vi.spyOn(adapter as any, '_resolveRunnerPath').mockReturnValue(runnerPath);

        const child = createMockChildProcess();
        spawnMock.mockReturnValue(child);

        const promise = adapter.execute(makeBinding(), makeRequest());
        await Promise.resolve();

        child.stdout.emit('data', JSON.stringify({
            ok: true,
            result: {
                passed: true,
                validator_name: 'ToxicLanguage',
            },
        }));
        child.emit('close', 0, null);

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.shouldDeny).toBe(false);
        expect(result.error).toBeUndefined();
        expect(spawnMock).toHaveBeenCalledWith(
            'python-local',
            [runnerPath],
            expect.objectContaining({ stdio: 'pipe' }),
        );
    });

    it('returns violation result when subprocess reports validator failure', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        const runnerPath = path.join(process.cwd(), 'runtime', 'guardrails', 'local_guardrails_runner.py');
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue('python-local');
        vi.spyOn(adapter as any, '_resolveRunnerPath').mockReturnValue(runnerPath);

        const child = createMockChildProcess();
        spawnMock.mockReturnValue(child);

        const promise = adapter.execute(makeBinding(), makeRequest());
        await Promise.resolve();

        child.stdout.emit('data', JSON.stringify({
            ok: true,
            result: {
                passed: false,
                validator_name: 'ToxicLanguage',
                error_message: 'Toxic phrase detected',
                fixed_value: '[redacted]',
            },
        }));
        child.emit('close', 0, null);

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.shouldDeny).toBe(true);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.message).toContain('Toxic phrase detected');
        expect(result.violations[0]?.fixedValue).toBe('[redacted]');
    });

    it('enforces timeout and returns adapter error result', async () => {
        vi.useFakeTimers();

        const adapter = new LocalGuardrailsAIAdapter();
        const runnerPath = path.join(process.cwd(), 'runtime', 'guardrails', 'local_guardrails_runner.py');
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue('python-local');
        vi.spyOn(adapter as any, '_resolveRunnerPath').mockReturnValue(runnerPath);

        const child = createMockChildProcess();
        spawnMock.mockReturnValue(child);

        const promise = adapter.execute(makeBinding({ timeoutMs: 25 }), makeRequest());
        await vi.advanceTimersByTimeAsync(30);
        const result = await promise;

        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.shouldDeny).toBe(true);
        expect(result.error).toContain('timed out');
    });

    it('returns adapter error when runner stdout is malformed JSON', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        const runnerPath = path.join(process.cwd(), 'runtime', 'guardrails', 'local_guardrails_runner.py');
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue('python-local');
        vi.spyOn(adapter as any, '_resolveRunnerPath').mockReturnValue(runnerPath);

        const child = createMockChildProcess();
        spawnMock.mockReturnValue(child);

        const promise = adapter.execute(makeBinding(), makeRequest());
        await Promise.resolve();

        child.stdout.emit('data', 'not-json');
        child.emit('close', 0, null);

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.shouldDeny).toBe(true);
        expect(result.error).toContain('malformed JSON');
    });

    it('returns clear missing-python error and honors failOpen', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue(undefined);

        const result = await adapter.execute(
            makeBinding({ failOpen: true }),
            makeRequest(),
        );

        expect(spawnMock).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.shouldDeny).toBe(false);
        expect(result.resolvedByFailOpen).toBe(true);
        expect(result.error).toContain('No Python interpreter found');
    });

    it('preserves existing PYTHONHOME/PYTHONPATH in subprocess env', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        const runnerPath = path.join(process.cwd(), 'runtime', 'guardrails', 'local_guardrails_runner.py');
        vi.spyOn(adapter as any, '_resolvePythonExecutable').mockResolvedValue('python-local');
        vi.spyOn(adapter as any, '_resolveRunnerPath').mockReturnValue(runnerPath);

        const priorHome = process.env.PYTHONHOME;
        const priorPath = process.env.PYTHONPATH;
        process.env.PYTHONHOME = 'C:/py-home';
        process.env.PYTHONPATH = 'C:/py-path';

        const child = createMockChildProcess();
        spawnMock.mockReturnValue(child);

        try {
            const promise = adapter.execute(makeBinding(), makeRequest());
            await Promise.resolve();

            child.stdout.emit('data', JSON.stringify({
                ok: true,
                result: {
                    passed: true,
                    validator_name: 'ToxicLanguage',
                },
            }));
            child.emit('close', 0, null);
            await promise;

            expect(spawnMock).toHaveBeenCalledWith(
                'python-local',
                [runnerPath],
                expect.objectContaining({
                    env: expect.objectContaining({
                        PYTHONHOME: 'C:/py-home',
                        PYTHONPATH: 'C:/py-path',
                        PYTHONUNBUFFERED: '1',
                    }),
                }),
            );
        } finally {
            if (priorHome === undefined) delete process.env.PYTHONHOME;
            else process.env.PYTHONHOME = priorHome;
            if (priorPath === undefined) delete process.env.PYTHONPATH;
            else process.env.PYTHONPATH = priorPath;
        }
    });
});
