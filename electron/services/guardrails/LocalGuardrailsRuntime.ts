import fs from 'fs';
import path from 'path';
import { APP_ROOT, resolveAppPath } from '../PathResolver';
import { SystemService } from '../SystemService';

export function resolveLocalGuardrailsRunnerPath(appRoot: string = APP_ROOT): string {
    if (appRoot === APP_ROOT) {
        return resolveAppPath(path.join('runtime', 'guardrails', 'local_guardrails_runner.py'));
    }
    return path.resolve(appRoot, 'runtime', 'guardrails', 'local_guardrails_runner.py');
}

export function buildProjectLocalPythonCandidates(appRoot: string = APP_ROOT): string[] {
    const isWin = process.platform === 'win32';

    return [
        // Bundled Python is preferred for deterministic packaged/dev behavior.
        path.join(appRoot, 'bin', 'python-win', 'python.exe'),
        path.join(appRoot, 'bin', 'python-mac', 'bin', 'python3'),
        path.join(appRoot, 'bin', 'python-linux', 'bin', 'python3'),
        path.join(appRoot, 'bin', 'python-portable', isWin ? 'python.exe' : 'python3'),
        path.join(appRoot, 'bin', 'python-portable', isWin ? 'python.exe' : path.join('bin', 'python3')),
        // Dedicated guardrails/local runtime envs.
        path.join(appRoot, 'runtime', 'guardrails', '.venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'runtime', 'guardrails', '.venv', 'bin', 'python3'),
        path.join(appRoot, 'runtime', 'guardrails', '.venv', 'bin', 'python'),
        // Project virtual environments.
        path.join(appRoot, 'local-inference', 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'local-inference', 'venv', 'bin', 'python3'),
        path.join(appRoot, 'local-inference', 'venv', 'bin', 'python'),
        path.join(appRoot, 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'venv', 'bin', 'python3'),
        path.join(appRoot, '.venv', 'bin', 'python3'),
        path.join(appRoot, 'mcp-servers', 'tala-core', 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'mcp-servers', 'tala-core', 'venv', 'bin', 'python3'),
    ];
}

export function findFirstExistingPythonPath(
    candidates: string[],
    fileExists: (filePath: string) => boolean = fs.existsSync,
): string | undefined {
    return candidates.find(candidate => fileExists(candidate));
}

export function buildLocalGuardrailsPythonEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    env.PYTHONUNBUFFERED = '1';
    return env;
}

export async function resolveLocalGuardrailsPythonPath(
    systemService: SystemService = new SystemService(),
    appRoot: string = APP_ROOT,
    fileExists: (filePath: string) => boolean = fs.existsSync,
): Promise<string | undefined> {
    const projectLocal = findFirstExistingPythonPath(
        buildProjectLocalPythonCandidates(appRoot),
        fileExists,
    );
    if (projectLocal) {
        return projectLocal;
    }

    const info = await systemService.detectEnv(appRoot);
    if (info.pythonEnvPath && fileExists(info.pythonEnvPath)) {
        return info.pythonEnvPath;
    }
    if (info.pythonPath && info.pythonPath !== 'Not Found') {
        return info.pythonPath;
    }

    return undefined;
}
