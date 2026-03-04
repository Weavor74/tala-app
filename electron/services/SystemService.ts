import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Contains comprehensive information about the user's system environment,
 * including operating system details, runtime paths and versions,
 * virtual environment detection, and merged environment variables.
 * 
 * This information is used throughout the application to:
 * - Determine which shell to use (PowerShell vs bash).
 * - Resolve Python/Node.js executables for function and MCP server execution.
 * - Inject proper environment variables (venv, `.env` file values).
 */
export interface SystemInfo {
    /** Operating system type (e.g., `'Windows_NT'`, `'Darwin'`, `'Linux'`). From `os.type()`. */
    os: string;
    /** Platform identifier (e.g., `'win32'`, `'darwin'`, `'linux'`). From `os.platform()`. */
    platform: string;
    /** CPU architecture (e.g., `'x64'`, `'arm64'`). From `os.arch()`. */
    arch: string;
    /** Absolute path to the Node.js executable, or `'Not Found'`. */
    nodePath: string;
    /** Node.js version string (e.g., `'v20.11.0'`). From `process.version`. */
    nodeVersion: string;
    /** Absolute path to the system Python executable, or `'Not Found'`. */
    pythonPath: string;
    /** Python version string (e.g., `'Python 3.11.5'`), may include venv info like `'(Venv: venv)'`. */
    pythonVersion: string;
    /** Absolute path to the Python executable inside a detected virtual environment (e.g., `venv/Scripts/python.exe`). */
    pythonEnvPath?: string;
    /** Absolute path to a `.env` file found in the workspace root, if one exists. */
    workspaceEnvFile?: string;
    /** Merged environment variables from `process.env`, venv activation, and `.env` file. */
    envVariables?: Record<string, string>;
}

/**
 * SystemService
 * 
 * Detects and reports comprehensive information about the user's system
 * environment. This is the foundation service that other services depend on
 * to resolve runtime paths and configure execution environments.
 * 
 * **Detection capabilities:**
 * 1. **OS Info**: Type, platform, and CPU architecture.
 * 2. **Node.js**: Path and version (via `where`/`which` commands).
 * 3. **Python (System)**: Path and version (tries `python` first, then `python3`).
 * 4. **Python (Venv)**: Deep-scans the workspace root and one level of subdirectories
 *    for virtual environments named `venv`, `.venv`, or `env`.
 * 5. **Environment Variables**: Merges `process.env` with venv environment and `.env` file values.
 * 
 * @example
 * ```typescript
 * const system = new SystemService();
 * const info = await system.detectEnv('/path/to/workspace');
 * console.log(info.pythonEnvPath); // '/path/to/workspace/venv/Scripts/python.exe'
 * console.log(info.envVariables?.OPENAI_API_KEY); // From .env file
 * ```
 */
export class SystemService {
    /**
     * Performs a comprehensive detection of the system environment.
     * 
     * **Detection phases:**
     * 
     * 1. **Basic OS info**: Reads `os.type()`, `os.platform()`, `os.arch()`.
     * 2. **Node.js detection**: Runs `where node` (Windows) or `which node` (Unix)
     *    to find the Node.js executable path.
     * 3. **Python detection (System)**: Tries `python --version` first, falls back
     *    to `python3 --version`. Uses `where`/`which` to resolve the executable path.
     * 4. **Virtual environment detection**: If `workspaceDir` is provided, scans for
     *    `venv/`, `.venv/`, or `env/` directories in the workspace root AND one level
     *    of subdirectories. For each candidate, checks if the Python executable exists
     *    (`Scripts/python.exe` on Windows, `bin/python` on Unix).
     * 5. **Venv environment capture**: When a venv is found, runs a tiny Python script
     *    inside the venv to dump `os.environ` as JSON, capturing all environment
     *    variables the venv would set (including `PATH` modifications). These are
     *    merged into the returned `envVariables`.
     * 6. **`.env` file parsing**: If a `.env` file exists in the workspace root,
     *    parses it line-by-line (supports `KEY=VALUE`, ignores comments `#`, strips
     *    surrounding quotes) and merges the values into `envVariables`.
     * 
     * **Environment variable priority** (last wins):
     * `process.env` < `venv os.environ` < `.env` file
     * 
     * @param {string} [workspaceDir] - Optional absolute path to the workspace root.
     *   If provided, enables venv detection, `.env` file parsing, and workspace-specific
     *   environment variable merging. If omitted, only system-level detection is performed.
     * @returns {Promise<SystemInfo>} A complete system information object.
     */
    public async detectEnv(workspaceDir?: string): Promise<SystemInfo> {
        const info: SystemInfo = {
            os: os.type(),
            platform: os.platform(),
            arch: os.arch(),
            nodePath: '',
            nodeVersion: process.version,
            pythonPath: '',
            pythonVersion: '',
            envVariables: { ...process.env } as Record<string, string> // Start with process env
        };

        // Detect Node Path
        try {
            const cmd = os.platform() === 'win32' ? 'where node' : 'which node';
            info.nodePath = execSync(cmd).toString().split('\n')[0].trim();
        } catch (e) {
            info.nodePath = 'Not Found';
        }

        // Detect Python (Bundled/Portable First)
        // Priority: universal platform-specific > portable > legacy
        const platformDir = os.platform() === 'win32' ? 'python-win'
            : os.platform() === 'darwin' ? 'python-mac' : 'python-linux';
        const pyExe = os.platform() === 'win32' ? 'python.exe' : path.join('bin', 'python3');
        const candidates = [
            path.join(process.cwd(), 'bin', platformDir, pyExe),
            path.join(process.cwd(), 'bin', 'python-portable', os.platform() === 'win32' ? 'python.exe' : 'python'),
            path.join(process.cwd(), 'bin', 'python', os.platform() === 'win32' ? 'python.exe' : path.join('bin', 'python3')),
        ];
        const bundledPython = candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];


        if (fs.existsSync(bundledPython)) {
            console.log(`[System] Using bundled portable Python: ${bundledPython}`);
            info.pythonPath = bundledPython;
            try {
                info.pythonVersion = execSync(`"${bundledPython}" --version`).toString().trim() + ' (Bundled)';
            } catch (e) {
                info.pythonVersion = 'Bundled (Version detection failed)';
            }
        } else {
            // Detect Python (System Level Fallback)
            try {
                let pyCmd = 'python';
                try {
                    info.pythonVersion = execSync('python --version').toString().trim();
                } catch {
                    pyCmd = 'python3';
                    info.pythonVersion = execSync('python3 --version').toString().trim();
                }

                const whereCmd = os.platform() === 'win32' ? `where ${pyCmd}` : `which ${pyCmd}`;
                info.pythonPath = execSync(whereCmd).toString().split('\n')[0].trim();
            } catch (e) {
                info.pythonPath = 'Not Found';
                info.pythonVersion = 'Not Found';
            }
        }

        // Detect Workspace Specifics (venv, .env)
        if (workspaceDir && fs.existsSync(workspaceDir)) {
            // Check for Python venv (Deep Scan: Root + 1 Level Subdirs)
            const venvNames = ['venv', '.venv', 'env'];
            // Create list of candidates: Root checks first, then subdirectories
            // PRIORITIZE tala-core as it's the main soul environment
            const candidates = [
                ...venvNames.map(name => path.join(workspaceDir, name)),
                ...venvNames.map(name => path.join(workspaceDir, 'mcp-servers', 'tala-core', name))
            ];

            try {
                const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
                for (const entry of entries) {
                    // Skip node_modules and vllm_engine (inference environment, often missing soul libs)
                    if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'vllm_engine'].includes(entry.name)) {
                        venvNames.forEach(vn => candidates.push(path.join(workspaceDir, entry.name, vn)));
                    }
                }
            } catch (e) { console.warn("Failed to scan subdirs for venv:", e); }

            for (const venvBase of candidates) {
                const pyExe = os.platform() === 'win32'
                    ? path.join(venvBase, 'Scripts', 'python.exe')
                    : path.join(venvBase, 'bin', 'python');

                if (fs.existsSync(pyExe)) {
                    info.pythonEnvPath = pyExe;
                    // Also try to get version of the venv python
                    try {
                        const localVer = execSync(`"${pyExe}" --version`).toString().trim();
                        const relPath = path.relative(workspaceDir, venvBase);
                        info.pythonVersion = `${localVer} (Venv: ${relPath})`;

                        // DEEP SCAN: Get Environment Variables from within Python
                        // This captures variables set by activation logic if likely (or at least sys.prefix related)
                        // We run a tiny script to dump os.environ
                        const jsonEnv = execSync(`"${pyExe}" -c "import os, json; print(json.dumps(dict(os.environ)))"`).toString();
                        const pyEnv = JSON.parse(jsonEnv);
                        // Merge into info.envVariables (Python wins conflicts if we consider it the runtime env)
                        if (info.envVariables) {
                            info.envVariables = { ...info.envVariables, ...pyEnv };

                            // Explicitly mark VIRTUAL_ENV if needed/missing
                            if (!info.envVariables!['VIRTUAL_ENV']) {
                                info.envVariables!['VIRTUAL_ENV'] = venvBase;
                            }
                        }
                    } catch (e) {
                        console.error('Failed to scan python environment variables', e);
                    }
                    break;
                }
            }

            // Check for .env file
            const envPath = path.join(workspaceDir, '.env');
            if (fs.existsSync(envPath)) {
                info.workspaceEnvFile = envPath;
                try {
                    const envContent = fs.readFileSync(envPath, 'utf-8');
                    envContent.split('\n').forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                            const [key, ...valParts] = trimmed.split('=');
                            const val = valParts.join('='); // Re-join in case value has =
                            // Remove quotes if present
                            const cleanVal = val.replace(/^["']|["']$/g, '').trim();
                            if (info.envVariables) {
                                info.envVariables[key.trim()] = cleanVal;
                            }
                        }
                    });
                } catch (e) {
                    console.error('Failed to parse .env file', e);
                }
            }
        }

        return info;
    }

    /**
     * Resolves the canonical Python executable for MCP servers.
     * Always prefers bundled/portable python unless useMcpVenv is explicitly true.
     */
    public resolveMcpPythonPath(config?: { useMcpVenv?: boolean }, currentInfo?: SystemInfo): string {
        const info = currentInfo || { pythonPath: '', pythonEnvPath: '' };

        // Venv python must NEVER be selected unless a config flag explicitly enables it (default false).
        if (config?.useMcpVenv && info.pythonEnvPath) {
            return info.pythonEnvPath;
        }

        // info.pythonPath is already resolved to bundled if available in detectEnv
        // Default MUST be <repoRoot>\bin\python-win\python.exe (resolved in info.pythonPath)
        return info.pythonPath || 'python';
    }

    /**
     * Constructs a sanitized environment for MCP Python processes.
     * Removes PYTHONHOME/PYTHONPATH to prevent conflicts and sets standard flags.
     */
    public getMcpEnv(baseEnv?: Record<string, string>): Record<string, string> {
        const env = { ...(baseEnv || process.env) } as Record<string, string>;

        // Remove PYTHONHOME/PYTHONPATH to prevent venv pollution
        delete env.PYTHONHOME;
        delete env.PYTHONPATH;

        // Set essential flags
        env.PYTHONNOUSERSITE = '1';
        env.PYTHONUNBUFFERED = '1';

        // TALA_USER_ID must be preserved or added if missing (usually passed from AgentService)
        if (!env.TALA_USER_ID) {
            env.TALA_USER_ID = process.env.TALA_USER_ID || 'anonymous-user';
        }

        return env;
    }

    /**
     * Performs a mandatory preflight check to ensure the Python interpreter can import stdlib.
     * Throws an error on failure.
     */
    public preflightCheck(pythonPath: string): void {
        try {
            const checkCmd = `"${pythonPath}" -c "import encodings, sys; print('ok')"`;
            const output = execSync(checkCmd, {
                timeout: 5000,
                env: { ...process.env, PYTHONNOUSERSITE: '1' },
                stdio: ['ignore', 'pipe', 'ignore']
            }).toString().trim();

            if (output !== 'ok') {
                throw new Error(`Unexpected output: ${output}`);
            }
        } catch (e: unknown) {
            const errorMsg = `[SystemService] Preflight check failed for ${pythonPath}: ${(e as Error).message}`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
    }
}
