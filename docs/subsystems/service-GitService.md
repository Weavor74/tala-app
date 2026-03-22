# Service: GitService.ts

**Source**: [electron/services/GitService.ts](../../electron/services/GitService.ts)

## Class: `GitService`

## Overview
GitService - Infrastructure Operations
 
 Provides a production-grade interface for Git repository operations. This service
 wraps the system `git` command-line tool, providing TALA with the ability to 
 inspect code state, manage branches, and synchronize with remote repositories.
 
 **System Role:**
 - Powers the "Source Control" and "Git View" components in the renderer.
 - Used by autonomous engines (e.g., `ReflectionService`) to verify repo state.
 - Handles complex auth-token injection for seamless GitHub integration.
 
 **Safety & Trust Boundaries:**
 - Commands are executed as external processes via `child_process.exec`.
 - Trust is limited to the `workspaceDir` provided during instantiation.
 - Mutation operations (commit, push, checkout) are gated by UI or agent logic.
 - Shell-sensitive inputs (messages, branch names) are escaped or quoted.
/

import { exec } from 'child_process';
import path from 'path';

/**
 Represents the status of a single file in a Git working tree.
 Used to display staged/unstaged changes in the SourceControl UI component.
/
export interface GitStatus {
    /** Relative path of the file within the repository. */
    path: string;
    /** Single-character Git status code: M(odified), A(dded), D(eleted), ?(Untracked), U(pdated/conflict). */
    status: 'M' | 'A' | 'D' | '?' | 'U';
    /** `true` if this change is in the staging area (index), `false` if it's in the working tree only. */
    staged: boolean;
}

/**
 GitService
 
 Provides a complete Git interface for the Tala workspace, wrapping the
 system `git` command-line tool and exposing high-level operations for
 the frontend SourceControl and GitView components.
 
 **Capabilities:**
 - Repository initialization, status, staging, committing
 - Branch management (create, checkout, delete)
 - Remote sync (fetch, pull, push) with optional GitHub token injection
 - Stash push/pop
 - Commit log retrieval and unified diff generation
 - GitHub API integration for listing user repositories
 
 **Git detection:**
 On Windows, `checkOk()` probes common installation paths if `git` isn't
 on the PATH (e.g., `C:\Program Files\Git\cmd\git.exe`).
 
 **Logging:**
 Debug messages are appended to `git_debug_log.txt` in the workspace root
 for troubleshooting Git detection and sync issues.
 
 @example
 ```typescript
 const git = new GitService('/path/to/workspace');
 if (await git.checkOk()) {
     const status = await git.getStatus();
     await git.stage('src/App.tsx');
     await git.commit('Update App component');
 }
 ```

### Methods

#### `init`
Initializes a new Git repository in the workspace directory.
 
 Runs `git init` in the workspace root. If a repository already exists,
 Git will reinitialize it (a safe no-op).
 
 @returns {Promise<void>}
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `log`
Writes a timestamped debug message to `git_debug_log.txt` in the workspace.
 
 Used internally for troubleshooting Git executable detection and
 sync operations. Failures are logged to the console but don't propagate.
 
 @private
 @param {string} msg - The debug message to log.
/

**Arguments**: `msg: string`

---
#### `setRoot`
Updates the workspace root directory for all subsequent Git operations.
 
 Called when the user changes the active workspace directory in the UI.
 Does NOT validate that the new path contains a Git repository.
 
 @param {string} newRoot - New absolute path to set as the working directory.
/

**Arguments**: `newRoot: string`

---
#### `run`
Executes a Git command in the workspace directory and returns its stdout.
 
 If the command starts with `'git '`, the `git` prefix is replaced with
 the resolved `gitPath` (which may point to a specific executable found
 by `checkOk()`).
 
 @private
 @param {string} command - The Git command to run (e.g., `'git status --porcelain'`).
 @returns {Promise<string>} The trimmed stdout output.
 @throws {string} Combined error message and stderr on failure.
/

**Arguments**: `command: string`
**Returns**: `Promise<string>`

---
#### `checkOk`
Checks whether Git is available on this system.
 
 **Multi-step Detection on Windows:**
 1. Try default 'git' on PATH.
 2. Probe common install paths (Program Files, LocalAppData).
 3. Verify executable via `git --version`.
 
 @returns `true` if a working git executable is found.
/

**Arguments**: ``
**Returns**: `Promise<boolean>`

---
#### `getStatus`
Retrieves the current Git status of files in the workspace.
 
 **Parsing Logic:**
 - Uses `git status --porcelain`.
 - Maps Git's 2-character status codes (XY) to `GitStatus` objects.
 - Reports files separately for staged and unstaged worktrees if both apply.
 
 @returns Array of file status descriptors.
 @throws error if not a git repository.
/

**Arguments**: ``
**Returns**: `Promise<GitStatus[]>`

---
#### `stage`
Stages a file for the next commit.
 
 @param {string} file - Relative path to the file to stage (e.g., `'src/App.tsx'`).
 @returns {Promise<void>}
/

**Arguments**: `file: string`
**Returns**: `Promise<void>`

---
#### `unstage`
Removes a file from the staging area (index) without discarding changes.
 
 @param {string} file - Relative path to the file to unstage.
 @returns {Promise<void>}
/

**Arguments**: `file: string`
**Returns**: `Promise<void>`

---
#### `commit`
Creates a new commit with the staged changes and the given message.
 
 Double quotes in the message are escaped to prevent shell injection.
 
 @param {string} message - The commit message.
 @returns {Promise<void>}
/

**Arguments**: `message: string`
**Returns**: `Promise<void>`

---
#### `scanRemotes`
Lists all configured remote URLs for the repository.
 
 @returns {Promise<string[]>} Array of remote URL lines (e.g., `'origin\thttps://...\t(fetch)'`).
   Returns an empty array if no remotes are configured or the command fails.
/

**Arguments**: ``
**Returns**: `Promise<string[]>`

---
#### `sync`
Synchronizes the local repository with the remote `origin`.
 
 Performs a fetch → pull → push sequence. If a GitHub token and optionally
 a username are provided, the credentials are injected into the HTTPS
 remote URL for authentication (removing any existing credentials first).
 
 **Auth injection format:**
 - With username: `https://username:token@github.com/repo.git`
 - Without username: `https://token@github.com/repo.git`
 
 Pull errors are logged but don't prevent the push attempt.
 
 @param {string} [token] - GitHub Personal Access Token for authentication.
 @param {string} [username] - GitHub username (optional, used with token).
 @returns {Promise<string>} Status message ("Sync complete." or error description).
/

**Arguments**: `token?: string, username?: string`
**Returns**: `Promise<string>`

---
#### `getBranches`
Lists all local branches in the repository.
 
 @returns {Promise<string[]>} Array of branch names (short format).
/

**Arguments**: ``
**Returns**: `Promise<string[]>`

---
#### `getCurrentBranch`
Returns the name of the currently checked-out branch.
 
 @returns {Promise<string>} The current branch name (e.g., `'main'`).
/

**Arguments**: ``
**Returns**: `Promise<string>`

---
#### `checkout`
Switches to an existing branch.
 
 @param {string} branch - The name of the branch to check out.
 @returns {Promise<void>}
/

**Arguments**: `branch: string`
**Returns**: `Promise<void>`

---
#### `createBranch`
Creates a new branch and switches to it.
 
 @param {string} name - The name for the new branch.
 @returns {Promise<void>}
/

**Arguments**: `name: string`
**Returns**: `Promise<void>`

---
#### `deleteBranch`
Force-deletes a local branch.
 
 Uses `-D` (force delete) which deletes the branch even if it hasn't
 been fully merged. Use with caution.
 
 @param {string} name - The name of the branch to delete.
 @returns {Promise<void>}
/

**Arguments**: `name: string`
**Returns**: `Promise<void>`

---
#### `getLog`
Retrieves the commit log for the current branch.
 
 Returns a structured array of commit objects, parsed from Git's
 `--pretty=format` output using `|` as a delimiter.
 
 @param {number} [limit=20] - Maximum number of commits to retrieve.
 @returns {Promise<{ hash: string, author: string, date: string, subject: string }[]>}
   Array of commit objects, newest first.
/

**Arguments**: `limit: number = 20`
**Returns**: `Promise<any[]>`

---
#### `getDiff`
Returns the unified diff for the working tree.
 
 If a specific file is provided, returns only that file's diff.
 Otherwise, returns the diff for all modified files.
 
 @param {string} [file] - Optional relative path to diff a specific file.
 @returns {Promise<string>} The unified diff output.
/

**Arguments**: `file?: string`
**Returns**: `Promise<string>`

---
#### `stashPush`
Stashes all uncommitted changes (both staged and unstaged).
 
 @returns {Promise<void>}
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `stashPop`
Restores the most recently stashed changes and removes the stash entry.
 
 @returns {Promise<void>}
 @throws {Error} If the stash is empty or conflicts occur during pop.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `fetchGithubRepos`
Fetches a list of GitHub repositories for the given user.
 
 **Authentication modes:**
 - **With token:** Calls the authenticated `/user/repos` endpoint, which
   includes private repositories. The token is sent as a Bearer token.
 - **Without token:** Calls the public `/users/{username}/repos` endpoint,
   which only shows public repositories.
 
 Results are sorted by most recently updated, limited to 100 repos.
 
 @param {string} username - The GitHub username.
 @param {string} token - GitHub Personal Access Token.
 @returns {Promise<any[]>} Array of simplified repo objects with `id`, `name`,
   `full_name`, `private`, `html_url`, `description`, and `updated_at`.
/

**Arguments**: `username: string, token: string`
**Returns**: `Promise<any[]>`

---
#### `getRemoteSlug`
Parses the 'origin' remote URL to extract the "owner/repo" slug.
 Supports both HTTPS and SSH formats.
 
 @returns {Promise<string | null>} The "owner/repo" string, or null if not found.
/

**Arguments**: ``
**Returns**: `Promise<string | null>`

---
#### `fetchGithubIssues`
Fetches open issues for a specific GitHub repository.
 
 @param owner - The repository owner.
 @param repo - The repository name.
 @param token - GitHub authentication token.
 @returns Array of open issues sorted by recently updated.
/

**Arguments**: `owner: string, repo: string, token: string`
**Returns**: `Promise<any[]>`

---
#### `fetchGithubPRs`
Fetches open pull requests for a specific GitHub repository.
 
 @param owner - The repository owner.
 @param repo - The repository name.
 @param token - GitHub authentication token.
 @returns Array of open PRs sorted by recently updated.
/

**Arguments**: `owner: string, repo: string, token: string`
**Returns**: `Promise<any[]>`

---
#### `fetchGithubAPI`
Generic helper for fetching data from the GitHub API.
 
 @private
 @param url - The GitHub API endpoint.
 @param token - Bearer token for authentication.
/

**Arguments**: `url: string, token: string`
**Returns**: `Promise<any[]>`

---
