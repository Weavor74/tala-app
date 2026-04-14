import path from 'path';
import {
    buildLocalGuardrailsPythonEnv,
    buildProjectLocalPythonCandidates,
    findFirstExistingPythonPath,
    resolveLocalGuardrailsPythonPath,
    resolveLocalGuardrailsRunnerPath,
} from '../../services/guardrails/LocalGuardrailsRuntime';

describe('LocalGuardrailsRuntime path resolution', () => {
    it('resolves runner path for a dev-style app root', () => {
        const appRoot = path.resolve('D:/src/client1/tala-app');
        const runnerPath = resolveLocalGuardrailsRunnerPath(appRoot);
        expect(runnerPath).toBe(path.resolve(appRoot, 'runtime', 'guardrails', 'local_guardrails_runner.py'));
    });

    it('resolves runner path for a packaged-style app root', () => {
        const appRoot = path.resolve('D:/apps/Tala');
        const runnerPath = resolveLocalGuardrailsRunnerPath(appRoot);
        expect(runnerPath).toBe(path.resolve(appRoot, 'runtime', 'guardrails', 'local_guardrails_runner.py'));
    });

    it('includes project-local venv and bundled python candidates', () => {
        const appRoot = path.resolve('D:/apps/Tala');
        const candidates = buildProjectLocalPythonCandidates(appRoot);

        expect(candidates.some(c => c.includes(path.join('local-inference', 'venv')))).toBe(true);
        expect(candidates.some(c => c.includes(path.join('venv')))).toBe(true);
        expect(candidates.some(c => c.includes(path.join('bin', 'python-win')) || c.includes(path.join('bin', 'python-portable')))).toBe(true);
    });

    it('prioritizes bundled python before generic project venv candidates', () => {
        const appRoot = path.resolve('D:/apps/Tala');
        const candidates = buildProjectLocalPythonCandidates(appRoot);

        const bundledIndex = candidates.findIndex(c => c.includes(path.join('bin', 'python-win')));
        const venvIndex = candidates.findIndex(c => c.includes(path.join('local-inference', 'venv')));

        expect(bundledIndex).toBeGreaterThanOrEqual(0);
        expect(venvIndex).toBeGreaterThanOrEqual(0);
        expect(bundledIndex).toBeLessThan(venvIndex);
    });

    it('selects first existing candidate deterministically', () => {
        const appRoot = path.resolve('D:/apps/Tala');
        const candidates = [
            path.join(appRoot, 'bin', 'python-win', 'python.exe'),
            path.join(appRoot, 'local-inference', 'venv', 'Scripts', 'python.exe'),
        ];
        const exists = (filePath: string) => filePath.includes(path.join('bin', 'python-win'));

        const selected = findFirstExistingPythonPath(candidates, exists);
        expect(selected).toBe(candidates[0]);
    });

    it('merges spawn environment without wiping PYTHONHOME/PYTHONPATH', () => {
        const env = buildLocalGuardrailsPythonEnv({
            PATH: 'X',
            PYTHONHOME: 'C:/py-home',
            PYTHONPATH: 'C:/py-path',
        });

        expect(env.PYTHONHOME).toBe('C:/py-home');
        expect(env.PYTHONPATH).toBe('C:/py-path');
        expect(env.PYTHONUNBUFFERED).toBe('1');
    });

    it('resolves bundled interpreter before fallback system interpreter', async () => {
        const appRoot = path.resolve('D:/apps/Tala');
        const bundled = path.join(appRoot, 'bin', 'python-win', 'python.exe');
        const resolved = await resolveLocalGuardrailsPythonPath(
            {
                detectEnv: async () => ({
                    pythonPath: 'C:/Python311/python.exe',
                    pythonEnvPath: 'C:/venv/Scripts/python.exe',
                }),
            } as any,
            appRoot,
            (filePath: string) => filePath === bundled,
        );
        expect(resolved).toBe(bundled);
    });
});
