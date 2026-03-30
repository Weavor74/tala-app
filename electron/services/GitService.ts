/**
 * GitService - Infrastructure Operations
 * 
 * Provides a production-grade interface for Git repository operations. This service
 * wraps the system `git` command-line tool, providing TALA with the ability to 
 * inspect code state, manage branches, and synchronize with remote repositories.
 * 
 * **System Role:**
 * - Powers the "Source Control" and "Git View" components in the renderer.
 * - Used by autonomous engines (e.g., `ReflectionService`) to verify repo state.
 * - Handles complex auth-token injection for seamless GitHub integration.
 * 
 * **Safety & Trust Boundaries:**
 * - Commands are executed as external processes via `child_process.exec`.
 * - Trust is limited to the `workspaceDir` provided during instantiation.
 * - Mutation operations (commit, push, checkout) are gated by UI or agent logic.
 * - Shell-sensitive inputs (messages, branch names) are escaped or quoted.
 */

import { exec } from 'child_process';
import path from 'path';

/**
 * Represents the status of a single file in a Git working tree.
 * Used to display staged/unstaged changes in the SourceControl UI component.
 */
export interface GitStatus {
    /** Relative path of the file within the repository. */
    path: string;
    /** Single-character Git status code: M(odified), A(dded), D(eleted), ?(Untracked), U(pdated/conflict). */
    status: 'M' | 'A' | 'D' | '?' | 'U';
    /** `true` if this change is in the staging area (index), `false` if it's in the working tree only. */
    staged: boolean;
}

/**
 * GitService
 * 
 * Provides a complete Git interface for the Tala workspace, wrapping the
 * system `git` command-line tool and exposing high-level operations for
 * the frontend SourceControl and GitView components.
 * 
 * **Capabilities:**
 * - Repository initialization, status, staging, committing
 * - Branch management (create, checkout, delete)
 * - Remote sync (fetch, pull, push) with optional GitHub token injection
 * - Stash push/pop
 * - Commit log retrieval and unified diff generation
 * - GitHub API integration for listing user repositories
 * 
 * **Git detection:**
 * On Windows, `checkOk()` probes common installation paths if `git` isn't
 * on the PATH (e.g., `C:\Program Files\Git\cmd\git.exe`).
 * 
 * **Logging:**
 * Debug messages are appended to `git_debug_log.txt` in the workspace root
 * for troubleshooting Git detection and sync issues.
 * 
 * @example
 * ```typescript
 * const git = new GitService('/path/to/workspace');
 * if (await git.checkOk()) {
 *     const status = await git.getStatus();
 *     await git.stage('src/App.tsx');
 *     await git.commit('Update App component');
 * }
 * ```
 */
export class GitService {
    /** Absolute path to the current Git working directory. */
    private workspaceDir: string;
    /** Resolved path to the git executable (may be updated by `checkOk()` if found in a non-standard location). */
    private gitPath: string = 'git';

    /**
     * Creates a new GitService instance for the specified workspace directory.
     * 
     * @param {string} workspaceDir - Absolute path to the Git repository root.
     */
    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    /**
     * Initializes a new Git repository in the workspace directory.
     * 
     * Runs `git init` in the workspace root. If a repository already exists,
     * Git will reinitialize it (a safe no-op).
     * 
     * @returns {Promise<void>}
     */
    public async init(): Promise<void> {
        await this.run('git init');
    }

    /**
     * Writes a timestamped debug message to `git_debug_log.txt` in the workspace.
     * 
     * Used internally for troubleshooting Git executable detection and
     * sync operations. Failures are logged to the console but don't propagate.
     * 
     * @private
     * @param {string} msg - The debug message to log.
     */
    private log(msg: string) {
        const fs = require('fs');
        const logPath = path.join(this.workspaceDir, 'git_debug_log.txt');
        try {
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
        } catch (e) { console.error('Failed to write log:', e); }
    }

    /**
     * Updates the workspace root directory for all subsequent Git operations.
     * 
     * Called when the user changes the active workspace directory in the UI.
     * Does NOT validate that the new path contains a Git repository.
     * 
     * @param {string} newRoot - New absolute path to set as the working directory.
     */
    public setRoot(newRoot: string) {
        this.workspaceDir = newRoot;
    }

    /**
     * Executes a Git command in the workspace directory and returns its stdout.
     * 
     * If the command starts with `'git '`, the `git` prefix is replaced with
     * the resolved `gitPath` (which may point to a specific executable found
     * by `checkOk()`).
     * 
     * @private
     * @param {string} command - The Git command to run (e.g., `'git status --porcelain'`).
     * @returns {Promise<string>} The trimmed stdout output.
     * @throws {string} Combined error message and stderr on failure.
     */
    private async run(command: string): Promise<string> {
        // If command starts with 'git ', replace it with the resolved path.
        // This is a simple generic replacement.
        let finalCommand = command;
        if (command.startsWith('git ')) {
            finalCommand = `"${this.gitPath}" ${command.substring(4)}`;
        }

        return new Promise((resolve, reject) => {
            exec(finalCommand, { cwd: this.workspaceDir }, (error, stdout, stderr) => {
                if (error) {
                    reject(error.message + '\n' + stderr);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    /**
     * Checks whether Git is available on this system.
     * 
     * Performs a multi-step detection:
     * 1. Tries the default `git` command (from PATH).
     * 2. If that fails, probes common Windows installation paths:
     *    - `C:\Program Files\Git\cmd\git.exe`
     *    - `C:\Program Files\Git\bin\git.exe`
     *    - `%LOCALAPPDATA%\Programs\Git\cmd\git.exe`
     * 3. Verifies each found path by running `git --version`.
     * 
     * If a working Git executable is found at a non-default path, `gitPath`
     * is updated so all subsequent `run()` calls use that path.
     * 
     * All steps are logged to `git_debug_log.txt` for troubleshooting.
     * 
     * @returns {Promise<boolean>} `true` if Git is available, `false` otherwise.
     */
    /**
     * Checks whether Git is available on this system.
     * 
     * **Multi-step Detection on Windows:**
     * 1. Try default 'git' on PATH.
     * 2. Probe common install paths (Program Files, LocalAppData).
     * 3. Verify executable via `git --version`.
     * 
     * @returns `true` if a working git executable is found.
     */
    public async checkOk(): Promise<boolean> {
        this.log('checkOk called.');
        this.log('Current PATH: ' + process.env.PATH);

        // 1. Try default 'git'
        try {
            const v = await this.run('git --version');
            this.log('Success with default git: ' + v.substring(0, 50));
            return true;
        } catch (e: any) {
            this.log('Default git failed: ' + e.message);
            this.log('Checking common Windows paths...');
        }

        // 2. Check common paths
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const localAppData = process.env.LOCALAPPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '');
        const commonPaths = [
            path.join(programFiles, 'Git', 'cmd', 'git.exe'),
            path.join(programFiles, 'Git', 'bin', 'git.exe'),
            path.join(userProfile, 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
            ...(localAppData ? [path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
        ];

        const fs = require('fs');
        for (const p of commonPaths) {
            this.log('Checking path: ' + p);
            if (fs.existsSync(p)) {
                this.log('Found git at: ' + p);
                this.gitPath = p;
                try {
                    const v = await this.run('git --version');
                    this.log('Verification success: ' + v.substring(0, 50));
                    return true;
                } catch (e: any) {
                    this.log('Verification failed for found path: ' + e.message);
                }
            } else {
                // this.log('Not found at: ' + p);
            }
        }

        this.log('Git not found in any location.');
        console.error('[GitService] Git not found in common paths or PATH.');
        return false;
    }

    /**
     * Retrieves the current Git status of all files in the workspace.
     * 
     * Runs `git status --porcelain` and parses the two-character status codes.
     * The output format is `XY PATH` where:
     * - **X** = staged status (index)
     * - **Y** = working tree status
     * 
     * Files can appear twice if they have both staged and unstaged changes.
     * Untracked files (`??`) are reported as unstaged with status `'?'`.
     * 
     * @returns {Promise<GitStatus[]>} Array of file status objects.
     * @throws {Error} If `git status` fails (e.g., not a Git repo).
     */
    /**
     * Retrieves the current Git status of files in the workspace.
     * 
     * **Parsing Logic:**
     * - Uses `git status --porcelain`.
     * - Maps Git's 2-character status codes (XY) to `GitStatus` objects.
     * - Reports files separately for staged and unstaged worktrees if both apply.
     * 
     * @returns Array of file status descriptors.
     * @throws error if not a git repository.
     */
    public async getStatus(): Promise<GitStatus[]> {
        try {
            // --porcelain gives nice parseable output: "M  file.txt", " M file.txt", "MM file.txt", "?? file.txt"
            // XY PATH
            // X = staging status, Y = working tree status
            const output = await this.run('git status --porcelain');
            if (!output) return [];

            const files: GitStatus[] = [];

            output.split('\n').forEach(line => {
                if (!line) return;
                const x = line[0];
                const y = line[1];
                const filePath = line.substring(3).trim();

                // Logic to split into Staged vs Unstaged entries?
                // Or just list them and let UI decide?
                // Let's simplify: If it has X, it's staged. If it has Y, it's unstaged.
                // A file can be BOTH.

                // For simple UI, let's just return raw status and handle logic there, 
                // OR duplicate entries if it's both.

                if (x !== ' ' && x !== '?') {
                    files.push({ path: filePath, status: x as any, staged: true });
                }
                if (y !== ' ') {
                    files.push({ path: filePath, status: y as any, staged: false });
                }
                if (x === '?' && y === '?') {
                    files.push({ path: filePath, status: '?', staged: false });
                }
            });

            return files;
        } catch (e) {
            console.error('Git status failed:', e);
            throw e;
        }
    }

    /**
     * Stages a file for the next commit.
     * 
     * @param {string} file - Relative path to the file to stage (e.g., `'src/App.tsx'`).
     * @returns {Promise<void>}
     */
    public async stage(file: string): Promise<void> {
        await this.run(`git add "${file}"`);
    }

    /**
     * Removes a file from the staging area (index) without discarding changes.
     * 
     * @param {string} file - Relative path to the file to unstage.
     * @returns {Promise<void>}
     */
    public async unstage(file: string): Promise<void> {
        await this.run(`git restore --staged "${file}"`);
    }

    /**
     * Creates a new commit with the staged changes and the given message.
     * 
     * Double quotes in the message are escaped to prevent shell injection.
     * 
     * @param {string} message - The commit message.
     * @returns {Promise<void>}
     */
    public async commit(message: string): Promise<void> {
        // Escape quotes in message
        const safeMsg = message.replace(/"/g, '\\"');
        await this.run(`git commit -m "${safeMsg}"`);
    }

    /**
     * Lists all configured remote URLs for the repository.
     * 
     * @returns {Promise<string[]>} Array of remote URL lines (e.g., `'origin\thttps://...\t(fetch)'`).
     *   Returns an empty array if no remotes are configured or the command fails.
     */
    public async scanRemotes(): Promise<string[]> {
        try {
            const out = await this.run('git remote -v');
            return out.split('\n');
        } catch {
            return [];
        }
    }

    /**
     * Synchronizes the local repository with the remote `origin`.
     * 
     * Performs a fetch → pull → push sequence. If a GitHub token and optionally
     * a username are provided, the credentials are injected into the HTTPS
     * remote URL for authentication (removing any existing credentials first).
     * 
     * **Auth injection format:**
     * - With username: `https://username:token@github.com/repo.git`
     * - Without username: `https://token@github.com/repo.git`
     * 
     * Pull errors are logged but don't prevent the push attempt.
     * 
     * @param {string} [token] - GitHub Personal Access Token for authentication.
     * @param {string} [username] - GitHub username (optional, used with token).
     * @returns {Promise<string>} Status message ("Sync complete." or error description).
     */
    public async sync(token?: string, username?: string): Promise<string> {
        // 1. Get current remote
        let remoteUrl: string;
        try {
            const remoteOut = await this.run('git remote get-url origin');
            remoteUrl = remoteOut.trim();
        } catch (e) {
            return "No 'origin' remote found. Initialize git or add a remote first.";
        }

        let effectiveUrl = remoteUrl;

        // 2. Inject Auth if provided and URL is HTTPS
        if (token && effectiveUrl.startsWith('https://')) {
            // Remove existing auth if any (e.g. user:pass@)
            effectiveUrl = effectiveUrl.replace(/^https:\/\/.*@/, 'https://');

            if (username) {
                effectiveUrl = effectiveUrl.replace('https://', `https://${username}:${token}@`);
            } else {
                effectiveUrl = effectiveUrl.replace('https://', `https://${token}@`);
            }
        }

        try {
            this.log(`Syncing with ${remoteUrl.replace(token || 'TOKEN', '***')}`);

            // Fetch first to see if there are changes
            await this.run('git fetch origin');

            // Pull with rebase or merge? Let's stick to basic pull for now.
            try {
                await this.run('git pull origin HEAD');
            } catch (pullErr: any) {
                this.log(`Pull warning/error: ${pullErr.message}`);
                // Continue anyway if it's just "divergent branches" or similar, 
                // though push might fail later.
            }

            // Push to the (potentially authenticated) URL
            if (token) {
                await this.run(`git push "${effectiveUrl}" HEAD`);
            } else {
                await this.run(`git push origin HEAD`);
            }

            return "Sync complete.";
        } catch (e: any) {
            this.log(`Sync failed: ${e.message}`);
            return `Sync failed: ${e.message}`;
        }
    }

    /**
     * Lists all local branches in the repository.
     * 
     * @returns {Promise<string[]>} Array of branch names (short format).
     */
    public async getBranches(): Promise<string[]> {
        const out = await this.run('git branch --format="%(refname:short)"');
        return out.split('\n').filter(Boolean);
    }

    /**
     * Returns the name of the currently checked-out branch.
     * 
     * @returns {Promise<string>} The current branch name (e.g., `'main'`).
     */
    public async getCurrentBranch(): Promise<string> {
        return await this.run('git branch --show-current');
    }

    /**
     * Switches to an existing branch.
     * 
     * @param {string} branch - The name of the branch to check out.
     * @returns {Promise<void>}
     */
    public async checkout(branch: string): Promise<void> {
        await this.run(`git checkout "${branch}"`);
    }

    /**
     * Creates a new branch and switches to it.
     * 
     * @param {string} name - The name for the new branch.
     * @returns {Promise<void>}
     */
    public async createBranch(name: string): Promise<void> {
        await this.run(`git checkout -b "${name}"`);
    }

    /**
     * Force-deletes a local branch.
     * 
     * Uses `-D` (force delete) which deletes the branch even if it hasn't
     * been fully merged. Use with caution.
     * 
     * @param {string} name - The name of the branch to delete.
     * @returns {Promise<void>}
     */
    public async deleteBranch(name: string): Promise<void> {
        await this.run(`git branch -D "${name}"`);
    }

    /**
     * Retrieves the commit log for the current branch.
     * 
     * Returns a structured array of commit objects, parsed from Git's
     * `--pretty=format` output using `|` as a delimiter.
     * 
     * @param {number} [limit=20] - Maximum number of commits to retrieve.
     * @returns {Promise<{ hash: string, author: string, date: string, subject: string }[]>}
     *   Array of commit objects, newest first.
     */
    public async getLog(limit: number = 20): Promise<any[]> {
        const format = '%H|%an|%at|%s';
        const out = await this.run(`git log -n ${limit} --pretty=format:"${format}"`);
        if (!out) return [];

        return out.split('\n').map(line => {
            const [hash, author, timestamp, subject] = line.split('|');
            return {
                hash,
                author,
                date: new Date(parseInt(timestamp) * 1000).toISOString(),
                subject
            };
        });
    }

    /**
     * Returns the unified diff for the working tree.
     * 
     * If a specific file is provided, returns only that file's diff.
     * Otherwise, returns the diff for all modified files.
     * 
     * @param {string} [file] - Optional relative path to diff a specific file.
     * @returns {Promise<string>} The unified diff output.
     */
    public async getDiff(file?: string): Promise<string> {
        if (file) {
            return await this.run(`git diff "${file}"`);
        }
        return await this.run('git diff');
    }

    /**
     * Stashes all uncommitted changes (both staged and unstaged).
     * 
     * @returns {Promise<void>}
     */
    public async stashPush(): Promise<void> {
        await this.run('git stash');
    }

    /**
     * Restores the most recently stashed changes and removes the stash entry.
     * 
     * @returns {Promise<void>}
     * @throws {Error} If the stash is empty or conflicts occur during pop.
     */
    public async stashPop(): Promise<void> {
        await this.run('git stash pop');
    }

    /**
     * Fetches a list of GitHub repositories for the given user.
     * 
     * **Authentication modes:**
     * - **With token:** Calls the authenticated `/user/repos` endpoint, which
     *   includes private repositories. The token is sent as a Bearer token.
     * - **Without token:** Calls the public `/users/{username}/repos` endpoint,
     *   which only shows public repositories.
     * 
     * Results are sorted by most recently updated, limited to 100 repos.
     * 
     * @param {string} username - The GitHub username.
     * @param {string} token - GitHub Personal Access Token.
     * @returns {Promise<any[]>} Array of simplified repo objects with `id`, `name`,
     *   `full_name`, `private`, `html_url`, `description`, and `updated_at`.
     */
    public async fetchGithubRepos(username: string, token: string): Promise<any[]> {
        if (!username && !token) return [];

        try {
            // If token provided, get authenticated user's repos (includes private)
            // If only username, get public repos
            const url = token
                ? 'https://api.github.com/user/repos?sort=updated&per_page=100'
                : `https://api.github.com/users/${username}/repos?sort=updated&per_page=100`;

            const headers: any = {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Tala-App-Client'
            };

            if (token) {
                headers['Authorization'] = `token ${token}`;
            }

            const response = await fetch(url, { headers });
            if (!response.ok) {
                throw new Error(`GitHub API Error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            if (Array.isArray(data)) {
                return data.map((repo: any) => ({
                    id: repo.id,
                    name: repo.name,
                    full_name: repo.full_name,
                    private: repo.private,
                    html_url: repo.html_url,
                    description: repo.description,
                    updated_at: repo.updated_at
                }));
            }
            return [];
        } catch (e: any) {
            console.error('Failed to fetch repos:', e);
            throw e;
        }
    }
    /**
     * Parses the 'origin' remote URL to extract the "owner/repo" slug.
     * Supports both HTTPS and SSH formats.
     * 
     * @returns {Promise<string | null>} The "owner/repo" string, or null if not found.
     */
    public async getRemoteSlug(): Promise<string | null> {
        try {
            const remoteUrl = await this.run('git remote get-url origin');
            const cleanUrl = remoteUrl.trim().replace(/\.git$/, '');

            // Match HTTPS: https://github.com/owner/repo
            const httpsMatch = cleanUrl.match(/github\.com[\/:]([^\/]+)\/([^\/]+)/);
            if (httpsMatch) {
                return `${httpsMatch[1]}/${httpsMatch[2]}`;
            }

            // Match SSH: git@github.com:owner/repo
            const sshMatch = cleanUrl.match(/git@github\.com:([^\/]+)\/([^\/]+)/);
            if (sshMatch) {
                return `${sshMatch[1]}/${sshMatch[2]}`;
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Fetches open issues for a specific GitHub repository.
     * 
     * @param owner - The repository owner.
     * @param repo - The repository name.
     * @param token - GitHub authentication token.
     * @returns Array of open issues sorted by recently updated.
     */
    public async fetchGithubIssues(owner: string, repo: string, token: string): Promise<any[]> {
        if (!token) return [];
        const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&sort=updated`;
        return this.fetchGithubAPI(url, token);
    }

    /**
     * Fetches open pull requests for a specific GitHub repository.
     * 
     * @param owner - The repository owner.
     * @param repo - The repository name.
     * @param token - GitHub authentication token.
     * @returns Array of open PRs sorted by recently updated.
     */
    public async fetchGithubPRs(owner: string, repo: string, token: string): Promise<any[]> {
        if (!token) return [];
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated`;
        return this.fetchGithubAPI(url, token);
    }

    /**
     * Generic helper for fetching data from the GitHub API.
     * 
     * @private
     * @param url - The GitHub API endpoint.
     * @param token - Bearer token for authentication.
     */
    private async fetchGithubAPI(url: string, token: string): Promise<any[]> {
        try {
            const headers: any = {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'Tala-App-Client',
                'Authorization': `token ${token}`
            };

            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`);

            const data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch (e: any) {
            console.error(`GitHub API failed for ${url}:`, e);
            throw e;
        }
    }
}
