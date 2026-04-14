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
        path.join(appRoot, 'local-inference', 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'local-inference', 'venv', 'bin', 'python3'),
        path.join(appRoot, 'local-inference', 'venv', 'bin', 'python'),
        path.join(appRoot, 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, '.venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'venv', 'bin', 'python3'),
        path.join(appRoot, '.venv', 'bin', 'python3'),
        path.join(appRoot, 'mcp-servers', 'tala-core', 'venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'mcp-servers', 'tala-core', 'venv', 'bin', 'python3'),
        path.join(appRoot, 'bin', 'python-win', 'python.exe'),
        path.join(appRoot, 'bin', 'python-mac', 'bin', 'python3'),
        path.join(appRoot, 'bin', 'python-linux', 'bin', 'python3'),
        path.join(appRoot, 'bin', 'python-portable', isWin ? 'python.exe' : 'python3'),
        path.join(appRoot, 'bin', 'python-portable', isWin ? 'python.exe' : path.join('bin', 'python3')),
    ];
}

export async function resolveLocalGuardrailsPythonPath(
    systemService: SystemService = new SystemService(),
    appRoot: string = APP_ROOT,
): Promise<string | undefined> {
    const projectLocal = buildProjectLocalPythonCandidates(appRoot)
        .find(candidate => fs.existsSync(candidate));
    if (projectLocal) {
        return projectLocal;
    }

    const info = await systemService.detectEnv(appRoot);
    if (info.pythonEnvPath && fs.existsSync(info.pythonEnvPath)) {
        return info.pythonEnvPath;
    }
    if (info.pythonPath && info.pythonPath !== 'Not Found') {
        return info.pythonPath;
    }

    return undefined;
}
