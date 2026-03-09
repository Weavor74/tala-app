import * as fs from 'fs';
import * as path from 'path';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class RepoInspectionService {
    private rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir; // e.g., app.getAppPath() or absolute repo path during dev
    }

    private resolveSafePath(relativePath: string): string {
        const fullPath = path.resolve(this.rootDir, relativePath);
        if (!fullPath.startsWith(this.rootDir)) {
            throw new Error(`Path traversal denied: ${relativePath}`);
        }
        return fullPath;
    }

    public async readFile(relativePath: string): Promise<string> {
        const fullPath = this.resolveSafePath(relativePath);
        if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${relativePath}`);

        return fs.promises.readFile(fullPath, 'utf8');
    }

    public async readFiles(relativePaths: string[]): Promise<Record<string, string>> {
        const results: Record<string, string> = {};
        for (const p of relativePaths) {
            try {
                results[p] = await this.readFile(p);
            } catch (e: any) {
                results[p] = `Error reading file: ${e.message}`;
            }
        }
        return results;
    }

    public async searchCode(query: string, extension: string = 'ts'): Promise<string[]> {
        // Safe basic ripgrep or generic find wrapper. For simplicity, executing git grep or just findstr/grep.
        // Assuming running in a git repo during dev.
        try {
            const { stdout } = await execAsync(`git grep -n -i "${query}" -- "*.${extension}" "*.tsx"`, { cwd: this.rootDir });
            return stdout.split('\n').filter(l => l.trim() !== '');
        } catch (e: any) {
            // git grep exits with 1 if no results
            if (e.code === 1) return [];
            console.error('Code search failed:', e);
            return [];
        }
    }

    public async findReferences(symbolName: string): Promise<string[]> {
        return this.searchCode(symbolName);
    }

    public async listRelevantFiles(directory: string = '.'): Promise<string[]> {
        const safeDir = this.resolveSafePath(directory);

        // Fast git-based listing to avoid `node_modules` and heavy walks
        try {
            const { stdout } = await execAsync(`git ls-tree -r HEAD --name-only "${directory}"`, { cwd: this.rootDir });
            return stdout.split('\n').filter(l => l.trim() !== '' && (l.endsWith('.ts') || l.endsWith('.tsx') || l.endsWith('.json')));
        } catch (e) {
            console.error('File listing failed:', e);
            return [];
        }
    }

    public async summarizeModuleResponsibilities(relativePath: string): Promise<string> {
        // Returns the class headers or first 50 lines of an important file
        try {
            const content = await this.readFile(relativePath);
            const lines = content.split('\n');
            const snippet = lines.slice(0, 50).join('\n');
            return `Header preview for ${relativePath}:\n${snippet}\n... (truncated)`;
        } catch (e: any) {
            return `Could not summarize ${relativePath}: ${e.message}`;
        }
    }
}
