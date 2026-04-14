import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { LocalGuardrailsRuntimeHealth } from '../../services/guardrails/LocalGuardrailsRuntimeHealth';

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

describe('LocalGuardrailsRuntimeHealth', () => {
    it('reports not ready when runner is missing', async () => {
        const health = new LocalGuardrailsRuntimeHealth({
            resolvePythonPath: async () => 'python-local',
            resolveRunnerPath: () => '/app/runtime/guardrails/local_guardrails_runner.py',
            fileExists: () => false,
        });

        const result = await health.checkReadiness();

        expect(result.ready).toBe(false);
        expect(result.runner.exists).toBe(false);
        expect(result.guardrails.importable).toBe(false);
        expect(result.guardrails.error).toContain('Runner not found');
    });

    it('reports not ready when guardrails import is missing', async () => {
        const child = createMockChildProcess();
        const spawnProcess = vi.fn(() => child as unknown as ChildProcess);

        const health = new LocalGuardrailsRuntimeHealth({
            resolvePythonPath: async () => 'python-local',
            resolveRunnerPath: () => '/app/runtime/guardrails/local_guardrails_runner.py',
            fileExists: () => true,
            spawnProcess,
        });

        const pending = health.checkReadiness();
        await Promise.resolve();

        child.stdout.emit('data', JSON.stringify({
            ok: true,
            health: {
                guardrails_importable: false,
                error: 'ModuleNotFoundError: No module named guardrails',
                python_version: '3.11.9',
            },
        }));
        child.emit('close', 0, null);

        const result = await pending;
        expect(result.ready).toBe(false);
        expect(result.guardrails.importable).toBe(false);
        expect(result.guardrails.error).toContain('No module named guardrails');
    });

    it('reports ready when python, runner, and guardrails import are healthy', async () => {
        const child = createMockChildProcess();
        const spawnProcess = vi.fn(() => child as unknown as ChildProcess);

        const health = new LocalGuardrailsRuntimeHealth({
            resolvePythonPath: async () => 'python-local',
            resolveRunnerPath: () => '/app/runtime/guardrails/local_guardrails_runner.py',
            fileExists: () => true,
            spawnProcess,
        });

        const pending = health.checkReadiness();
        await Promise.resolve();

        child.stdout.emit('data', JSON.stringify({
            ok: true,
            health: {
                guardrails_importable: true,
                guardrails_version: '0.6.3',
                python_version: '3.11.9',
            },
        }));
        child.emit('close', 0, null);

        const result = await pending;
        expect(result.ready).toBe(true);
        expect(result.python.resolved).toBe(true);
        expect(result.runner.exists).toBe(true);
        expect(result.guardrails.importable).toBe(true);
        expect(result.guardrails.version).toBe('0.6.3');
    });
});
