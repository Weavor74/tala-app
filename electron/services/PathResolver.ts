import path from 'path';

const electronApp = (() => {
    try {
        // Avoid hard import-time dependency on electron.app in tests that mock only ipcMain.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('electron')?.app ?? null;
    } catch {
        return null;
    }
})();

/**
 * PathResolver
 * 
 * Canonical service for resolving application and data paths.
 * Enforces portability by prioritizing app-root-relative paths.
 */

/**
 * The application root directory.
 * - In Development: The project root (where package.json lives).
 * - In Production: The directory containing the executable.
 */
export const APP_ROOT = electronApp
    ? (electronApp.isPackaged
        ? path.dirname(electronApp.getPath('exe'))
        : electronApp.getAppPath())
    : process.cwd();

/**
 * The root directory for application data (settings, logs, local DBs).
 * Redirected to a local folder within APP_ROOT for portability.
 */
export const DATA_ROOT = path.join(APP_ROOT, 'data');
export const LOCAL_DATA_DIR = DATA_ROOT; // Alias for backward compatibility

export const DATA_DIRS = {
    logs: path.join(DATA_ROOT, 'logs'),
    cache: path.join(DATA_ROOT, 'cache'),
    temp: path.join(DATA_ROOT, 'temp'),
    memory: path.join(DATA_ROOT, 'memory'),
    reflection: path.join(DATA_ROOT, 'reflection'),
    diagnostics: path.join(DATA_ROOT, 'diagnostics'),
} as const;

export type ResolvePathOptions = {
    // Mark an absolute override as intentionally external (configured by user/operator).
    // Tala still allows it, but logs explicit visibility.
    externalByConfiguration?: boolean;
    // Optional label to make guard logs more actionable.
    label?: string;
};

function normalizePathForCompare(targetPath: string): string {
    return path.resolve(targetPath).replace(/[\\/]+$/g, '').toLowerCase();
}

function isWithinPath(targetPath: string, parentPath: string): boolean {
    const target = normalizePathForCompare(targetPath);
    const parent = normalizePathForCompare(parentPath);
    return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function logPathGuard(targetPath: string, message: string): void {
    console.warn(`[PathGuard] ${message} path=${targetPath}`);
}

function resolvePathWithGuard(
    baseDir: string,
    defaultRelativePath: string,
    override?: string,
    options?: ResolvePathOptions
): string {
    const label = options?.label ?? 'tala-owned-write';
    const resolved = override
        ? (path.isAbsolute(override) ? override : path.resolve(baseDir, override))
        : path.resolve(baseDir, defaultRelativePath);

    if (!isWithinPath(resolved, APP_ROOT)) {
        if (options?.externalByConfiguration) {
            console.info(`[PathGuard] external-by-configuration label=${label} path=${resolved}`);
        } else {
            logPathGuard(resolved, `write escaped app root label=${label}`);
        }
    }

    return resolved;
}

/**
 * Resolves a path relative to the application root.
 * 
 * Resolution Order:
 * 1. Explicit Absolute Path: If `override` is absolute, returns it as-is.
 * 2. Explicit Relative Path: If `override` is relative, resolves it against `APP_ROOT`.
 * 3. Default: Resolves `defaultRelativePath` against `APP_ROOT`.
 */
export function resolveAppPath(defaultRelativePath: string, override?: string, options?: ResolvePathOptions): string {
    return resolvePathWithGuard(APP_ROOT, defaultRelativePath, override, options);
}

/**
 * Resolves a path relative to the data root (APP_ROOT/data).
 */
export function resolveDataPath(defaultRelativePath: string, override?: string, options?: ResolvePathOptions): string {
    return resolvePathWithGuard(DATA_ROOT, defaultRelativePath, override, options);
}

/**
 * Returns the path to a bundled runtime asset.
 * Bundled assets are expected to live in APP_ROOT/runtime/.
 */
export function resolveRuntimePath(assetSubPath: string, override?: string): string {
    return resolveAppPath(path.join('runtime', assetSubPath), override);
}

export function resolveLogsPath(override?: string, options?: ResolvePathOptions): string {
    return resolveDataPath('logs', override, { label: 'logs', ...options });
}

export function resolveCachePath(override?: string, options?: ResolvePathOptions): string {
    return resolveDataPath('cache', override, { label: 'cache', ...options });
}

export function resolveTempPath(override?: string, options?: ResolvePathOptions): string {
    return resolveDataPath('temp', override, { label: 'temp', ...options });
}

export function resolveMemoryPath(override?: string, options?: ResolvePathOptions): string {
    return resolveDataPath('memory', override, { label: 'memory', ...options });
}

export function resolveReflectionPath(override?: string, options?: ResolvePathOptions): string {
    return resolveDataPath('reflection', override, { label: 'reflection', ...options });
}

export function isPathWithinAppRoot(targetPath: string): boolean {
    return isWithinPath(targetPath, APP_ROOT);
}
