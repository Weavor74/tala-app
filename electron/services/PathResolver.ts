import { app } from 'electron';
import path from 'path';

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
export const APP_ROOT = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : app.getAppPath();

/**
 * The root directory for application data (settings, logs, local DBs).
 * Redirected to a local folder within APP_ROOT for portability.
 */
export const DATA_ROOT = path.join(APP_ROOT, 'data');
export const LOCAL_DATA_DIR = DATA_ROOT; // Alias for backward compatibility

/**
 * Resolves a path relative to the application root.
 * 
 * Resolution Order:
 * 1. Explicit Absolute Path: If `override` is absolute, returns it as-is.
 * 2. Explicit Relative Path: If `override` is relative, resolves it against `APP_ROOT`.
 * 3. Default: Resolves `defaultRelativePath` against `APP_ROOT`.
 */
export function resolveAppPath(defaultRelativePath: string, override?: string): string {
    if (override) {
        if (path.isAbsolute(override)) {
            return override;
        }
        return path.resolve(APP_ROOT, override);
    }
    return path.resolve(APP_ROOT, defaultRelativePath);
}

/**
 * Resolves a path relative to the data root (APP_ROOT/data).
 */
export function resolveDataPath(defaultRelativePath: string, override?: string): string {
    if (override) {
        if (path.isAbsolute(override)) {
            return override;
        }
        return path.resolve(DATA_ROOT, override);
    }
    return path.resolve(DATA_ROOT, defaultRelativePath);
}

/**
 * Returns the path to a bundled runtime asset.
 * Bundled assets are expected to live in APP_ROOT/runtime/.
 */
export function resolveRuntimePath(assetSubPath: string, override?: string): string {
    return resolveAppPath(path.join('runtime', assetSubPath), override);
}
