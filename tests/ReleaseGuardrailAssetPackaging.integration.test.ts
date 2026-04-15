import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LocalGuardrailsRuntimeHealth } from '../electron/services/guardrails/LocalGuardrailsRuntimeHealth';
import { resolveLocalGuardrailsRunnerPath } from '../electron/services/guardrails/LocalGuardrailsRuntime';

const REQUIRED_PACKAGED_ARTIFACTS = [
    'resources',
    'mcp-servers',
    'local-inference',
    'runtime/guardrails',
    'launch-inference.bat',
    'launch-inference.sh',
    'PORTABLE_BUILD_README.md',
];

function makeTempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createPackagedLayout(root: string, missingRelPath?: string): string {
    const packagedRoot = path.join(root, 'dist', 'win-unpacked');
    fs.mkdirSync(packagedRoot, { recursive: true });
    for (const rel of REQUIRED_PACKAGED_ARTIFACTS) {
        if (rel === missingRelPath) continue;
        const abs = path.join(packagedRoot, rel);
        if (rel.includes('.')) {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, 'fixture');
        } else {
            fs.mkdirSync(abs, { recursive: true });
        }
    }
    fs.mkdirSync(path.join(packagedRoot, 'resources', 'app'), { recursive: true });
    if (missingRelPath !== 'runtime/guardrails') {
        fs.mkdirSync(path.join(packagedRoot, 'runtime', 'guardrails'), { recursive: true });
        fs.writeFileSync(path.join(packagedRoot, 'runtime', 'guardrails', 'local_guardrails_runner.py'), '# runner');
    }
    return packagedRoot;
}

function validatePackagedFixture(packagedRoot: string): void {
    for (const rel of REQUIRED_PACKAGED_ARTIFACTS) {
        const candidate = path.join(packagedRoot, rel);
        if (!fs.existsSync(candidate)) {
            throw new Error(`Packaged artifact missing: ${rel}`);
        }
    }
    const payloadCandidates = [
        path.join(packagedRoot, 'resources', 'app'),
        path.join(packagedRoot, 'resources', 'app.asar'),
    ];
    if (!payloadCandidates.some((candidate) => fs.existsSync(candidate))) {
        throw new Error('Packaged application payload missing (expected resources/app or resources/app.asar).');
    }
}

describe('Release guardrail asset packaging integration', () => {
    it('required governance/guardrail assets are present in packaged layout fixture', () => {
        const root = makeTempRoot('tala-release-packaged-assets-');
        const packagedRoot = createPackagedLayout(root);
        expect(() => validatePackagedFixture(packagedRoot)).not.toThrow();
    });

    it('packaged runtime lookup path aligns with guardrails runner path contract', () => {
        const root = makeTempRoot('tala-release-packaged-paths-');
        const packagedRoot = createPackagedLayout(root);
        const runtimeRunner = resolveLocalGuardrailsRunnerPath(packagedRoot);
        expect(runtimeRunner).toBe(path.resolve(packagedRoot, 'runtime', 'guardrails', 'local_guardrails_runner.py'));
        expect(fs.existsSync(runtimeRunner)).toBe(true);
    });

    it('missing packaged guardrail runner causes deterministic startup degradation', async () => {
        const runtime = new LocalGuardrailsRuntimeHealth({
            resolvePythonPath: async () => '/tmp/python',
            resolveRunnerPath: () => '/tmp/packaged/runtime/guardrails/local_guardrails_runner.py',
            fileExists: (candidate) => candidate === '/tmp/python',
        });

        const readiness = await runtime.checkReadiness(1);
        expect(readiness.ready).toBe(false);
        expect(readiness.runner.exists).toBe(false);
        expect(readiness.guardrails.error).toContain('Runner not found');
    });

    it('artifact validator fails deterministically for intentionally broken packaging fixtures', () => {
        const root = makeTempRoot('tala-release-packaged-broken-');
        const packagedRoot = createPackagedLayout(root, 'runtime/guardrails');
        expect(() => validatePackagedFixture(packagedRoot)).toThrow(/Packaged artifact missing: runtime\/guardrails/);
    });
});
