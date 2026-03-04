import { describe, it, expect } from 'vitest';
// @ts-ignore
import fs from 'fs';
// @ts-ignore
import path from 'path';

// Fix for ESM __dirname
const __dirname = path.dirname(new URL(import.meta.url).pathname);

describe('Identity Tripwire (Registry/Scanning)', () => {
    const forbiddenSeeds = ['Steven', 'Pollard', 'Orion', 'anonymous-user'];
    const searchDirs = ['src', 'electron', 'mcp-servers'];
    const excludePatterns = [
        'node_modules',
        'dist',
        'build',
        '__pycache__',
        '.git',
        'IdentityTripwire.test.ts', // Exclude this test file itself
        'walkthrough.md',           // Documentation of the work
        'implementation_plan.md'    // Planning docs
    ];

    function searchFiles(dir: string, callback: (filePath: string) => void) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const isExcluded = excludePatterns.some(p => fullPath.includes(p));
            if (isExcluded) continue;

            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                searchFiles(fullPath, callback);
            } else if (stat.isFile()) {
                const ext = path.extname(fullPath);
                if (['.ts', '.tsx', '.py', '.json', '.md', '.txt'].includes(ext)) {
                    callback(fullPath);
                }
            }
        }
    }

    it('should not contain forbidden identity strings in source code or prompts', () => {
        const rootDir = path.resolve(__dirname, '..');
        const violations: string[] = [];

        for (const dirName of searchDirs) {
            const searchPath = path.join(rootDir, dirName);
            if (!fs.existsSync(searchPath)) continue;

            searchFiles(searchPath, (filePath) => {
                const content = fs.readFileSync(filePath, 'utf-8');
                for (const seed of forbiddenSeeds) {
                    if (content.toLowerCase().includes(seed.toLowerCase())) {
                        // Double check with word boundary if possible, for now simple include
                        violations.push(`${seed} found in ${path.relative(rootDir, filePath)}`);
                    }
                }
            });
        }

        expect(violations.length, `Forbidden identity seeds found:\n${violations.join('\n')}`).toBe(0);
    });

    it('should enforce UUID format for any IDs used as primary keys in identity context', () => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // Example check: verify a placeholder or real profile if present
        const appData = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + '/.config');
        const profilePath = path.join(appData, 'tala-app', 'user-profile.json');

        if (fs.existsSync(profilePath)) {
            const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
            if (profile.userId) {
                expect(profile.userId).toMatch(uuidRegex);
                expect(profile.userId).not.toBe('anonymous-user');
            }
        }
    });
});
