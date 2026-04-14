import path from 'path';
import { buildProjectLocalPythonCandidates, resolveLocalGuardrailsRunnerPath } from '../../services/guardrails/LocalGuardrailsRuntime';

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
});
