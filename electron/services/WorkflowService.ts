import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/**
 * Represents a single saved workflow definition.
 * Workflows are visual automation graphs consisting of interconnected nodes
 * and edges, created in the WorkflowEditor component and executed by
 * the WorkflowEngine service.
 */
export interface WorkflowEntry {
    /** Unique identifier — also used as the filename (without `.json` extension). */
    id: string;
    /** Human-readable display name shown in the UI. */
    name: string;
    /** Brief description of what the workflow does. */
    description: string;
    /** Array of workflow nodes (agent, tool, if, http, transform, delay, etc.). */
    nodes: any[];
    /** Array of edges connecting nodes (defines execution flow). */
    edges: any[];
    /** Whether this workflow is currently active/enabled. */
    active: boolean;
    /** Optional schedule string (e.g. "@every 1h"). */
    schedule?: string;
    /** Timestamp of the last execution. */
    lastRun?: number;
}

/**
 * WorkflowService
 * 
 * Provides CRUD (Create, Read, Update, Delete) operations for workflow JSON files.
 * Workflows are stored as individual `.json` files in the `.agent/workflows/`
 * directory within the user's workspace.
 * 
 * This service handles persistence only — it does NOT execute workflows.
 * Execution is handled by the `WorkflowEngine` service.
 * 
 * File storage format:
 * ```
 * <workspace>/.agent/workflows/
 *   ├── my-workflow.json
 *   ├── daily-backup.json
 *   └── code-review.json
 * ```
 * 
 * Each JSON file contains a complete `WorkflowEntry` object with id, name,
 * description, nodes, edges, and active flag.
 * 
 * @example
 * ```typescript
 * const workflowService = new WorkflowService('/path/to/workspace');
 * const workflows = workflowService.listWorkflows();
 * workflowService.saveWorkflow({ id: 'new-wf', name: 'New', description: '', nodes: [], edges: [], active: true });
 * ```
 */
export class WorkflowService {
    /** The root workspace directory path. */
    private workspaceDir: string;
    /** Computed path to the `.agent/workflows/` directory within the workspace. */
    private workflowsDir: string;

    /**
     * Creates a new WorkflowService instance.
     * 
     * @param {string} initialRoot - Absolute path to the workspace root directory.
     *   The workflows directory will be created at `<initialRoot>/.agent/workflows/`.
     */
    constructor(initialRoot: string) {
        this.workspaceDir = initialRoot;
        this.workflowsDir = path.join(this.workspaceDir, '.agent', 'workflows');
    }

    /**
     * Ensures the workflows directory exists on disk.
     * Creates it recursively (including `.agent/` parent) if it doesn't exist.
     * Called internally before any read/write operation.
     * 
     * @private
     * @returns {void}
     */
    private ensureDir() {
        if (!fs.existsSync(this.workflowsDir)) {
            fs.mkdirSync(this.workflowsDir, { recursive: true });
        }
    }

    /**
     * Lists all saved workflows by scanning the workflows directory for `.json` files.
     * 
     * For each JSON file found:
     * 1. Reads and parses the file content.
     * 2. Validates that it has at least an `id` and `nodes` property.
     * 3. Adds valid entries to the result array.
     * 4. Logs a warning and skips invalid files (malformed JSON, missing required fields).
     * 
     * @returns {WorkflowEntry[]} Array of valid workflow entries found on disk.
     *   Returns an empty array if the directory doesn't exist, is empty, or
     *   all files are invalid.
     */
    public listWorkflows(): WorkflowEntry[] {
        this.ensureDir();
        try {
            const files = fs.readdirSync(this.workflowsDir);
            const workflows: WorkflowEntry[] = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const fullPath = path.join(this.workflowsDir, file);
                        const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));

                        // Basic validation
                        if (content.id && content.nodes) {
                            workflows.push(content);
                        }
                    } catch (err) {
                        console.warn(`[WorkflowService] Skipped invalid workflow: ${file}`, err);
                    }
                }
            }
            return workflows;
        } catch (e) {
            console.error('[WorkflowService] List failed:', e);
            return [];
        }
    }

    /**
     * Saves a workflow entry to disk as a JSON file.
     * 
     * The filename is derived from `workflow.id` after sanitizing it to remove
     * any characters that are not alphanumeric, hyphens, or underscores.
     * This prevents directory traversal attacks and filesystem issues.
     * 
     * If a file with the same ID already exists, it is overwritten (upsert behavior).
     * 
     * @param {WorkflowEntry} workflow - The workflow object to persist.
     * @returns {boolean} `true` if the file was written successfully, `false` on error.
     */
    public saveWorkflow(workflow: WorkflowEntry): boolean {
        this.ensureDir();
        try {
            const safeId = workflow.id.replace(/[^a-zA-Z0-9_-]/g, '');
            const filePath = path.join(this.workflowsDir, `${safeId}.json`);
            fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), 'utf-8');
            return true;
        } catch (e) {
            console.error('[WorkflowService] Save failed:', e);
            return false;
        }
    }

    /**
     * Deletes a workflow JSON file from disk by its ID.
     * 
     * The ID is sanitized before constructing the file path to prevent
     * directory traversal attacks. If the file doesn't exist, returns `false`.
     * 
     * @param {string} id - The unique identifier of the workflow to delete.
     * @returns {boolean} `true` if the file was found and deleted, `false` if
     *   the file didn't exist or an error occurred.
     */
    public deleteWorkflow(id: string): boolean {
        try {
            const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
            const filePath = path.join(this.workflowsDir, `${safeId}.json`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return false;
        } catch (e) {
            console.error('[WorkflowService] Delete failed:', e);
            return false;
        }
    }

    /**
     * Imports workflow definitions from a remote URL.
     * 
     * Fetches JSON from the given URL and attempts to parse it as workflow data.
     * Supports three input formats:
     * 1. **Array of workflows**: `[{ id, nodes, ... }, ...]`
     * 2. **Wrapper object**: `{ workflows: [{ id, nodes, ... }, ...] }`
     * 3. **Single workflow**: `{ id, nodes, ... }`
     * 
     * Each valid workflow in the parsed data is saved to disk via `saveWorkflow()`.
     * Invalid entries (missing `id` or `nodes`) are silently skipped.
     * 
     * @param {string} url - The URL to fetch workflow JSON from. Must return
     *   valid JSON in one of the three supported formats.
     * @returns {Promise<{ success: boolean; count: number; error?: string }>}
     *   - `success` — `true` if the fetch and parse succeeded.
     *   - `count` — Number of workflows successfully imported.
     *   - `error` — (only on failure) Human-readable error message.
     * 
     * @example
     * ```typescript
     * const result = await workflowService.importFromUrl('https://example.com/workflows.json');
     * console.log(`Imported ${result.count} workflows`);
     * ```
     */
    public async importFromUrl(url: string): Promise<{ success: boolean; count: number; error?: string }> {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            const data = await response.json();
            let workflows: WorkflowEntry[] = [];

            if (Array.isArray(data)) {
                workflows = data;
            } else if (data.workflows && Array.isArray(data.workflows)) {
                workflows = data.workflows;
            } else if (data.id && data.nodes) {
                workflows = [data];
            } else {
                throw new Error("Invalid workflow format (Expected array or object with nodes)");
            }

            let count = 0;
            for (const wf of workflows) {
                if (wf.id && wf.nodes) {
                    if (this.saveWorkflow(wf)) count++;
                }
            }

            return { success: true, count };
        } catch (e: any) {
            console.error('[WorkflowService] Import failed:', e);
            return { success: false, count: 0, error: e.message };
        }
    }

    /**
     * Saves a workflow execution run to disk.
     * @param {string} workflowId - ID of the workflow.
     * @param {string} runId - Unique ID for this run.
     * @param {any} data - The execution result/log data.
     */
    public saveRun(workflowId: string, runId: string, data: any) {
        const runsDir = path.join(this.workspaceDir, '.agent', 'workflow_runs');
        if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });

        // Sanitize IDs
        const safeWfId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '');
        const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '');

        const filename = `${safeWfId}_${safeRunId}.json`;
        try {
            fs.writeFileSync(path.join(runsDir, filename), JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('[WorkflowService] Failed to save run:', e);
        }
    }

    /**
     * Lists all execution runs for a specific workflow.
     * Scans the `.agent/workflow_runs/` directory for files matching `${workflowId}_*.json`.
     * 
     * @param {string} workflowId - ID of the workflow.
     * @returns {any[]} Array of run metadata (filename, id, timestamp, data).
     */
    public listRuns(workflowId: string): any[] {
        const runsDir = path.join(this.workspaceDir, '.agent', 'workflow_runs');
        if (!fs.existsSync(runsDir)) return [];

        const safeWfId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '');
        try {
            const files = fs.readdirSync(runsDir);
            const runs: any[] = [];

            for (const file of files) {
                if (file.startsWith(`${safeWfId}_`) && file.endsWith('.json')) {
                    try {
                        const fullPath = path.join(runsDir, file);
                        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));

                        // Extract runId from filename: {safeWfId}_{runId}.json
                        const runId = file.replace(`${safeWfId}_`, '').replace('.json', '');

                        runs.push({
                            runId,
                            filename: file,
                            timestamp: data.timestamp || fs.statSync(fullPath).mtimeMs,
                            success: data.success,
                            error: data.error,
                            duration: data.duration,
                            logs: data.logs,
                            context: data.context
                        });
                    } catch (err) {
                        console.warn(`[WorkflowService] Skipped invalid run file: ${file}`, err);
                    }
                }
            }

            // Sort by timestamp descending (newest first)
            return runs.sort((a, b) => b.timestamp - a.timestamp);
        } catch (e) {
            console.error('[WorkflowService] List runs failed:', e);
            return [];
        }
    }

    /**
     * Deletes a specific workflow run record.
     * 
     * @param {string} workflowId - ID of the workflow.
     * @param {string} runId - ID of the run to delete.
     * @returns {boolean} `true` if deleted, `false` otherwise.
     */
    public deleteRun(workflowId: string, runId: string): boolean {
        const runsDir = path.join(this.workspaceDir, '.agent', 'workflow_runs');
        const safeWfId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '');
        const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '');
        const filePath = path.join(runsDir, `${safeWfId}_${safeRunId}.json`);

        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return false;
        } catch (e) {
            console.error('[WorkflowService] Delete run failed:', e);
            return false;
        }
    }
    /**
     * Updates the last run timestamp of a workflow.
     */
    public updateLastRun(id: string, timestamp: number) {
        const workflows = this.listWorkflows();
        const wf = workflows.find(w => w.id === id);
        if (wf) {
            wf.lastRun = timestamp;
            this.saveWorkflow(wf);
        }
    }

    /**
     * Initializes the workflow scheduler.
     * Checks for due workflows every 60 seconds.
     * 
     * @param onExecute - Callback to execute a workflow by ID.
     */
    public initScheduler(onExecute: (id: string) => void) {
        setInterval(() => {
            this.checkSchedules(onExecute);
        }, 60000); // Check every minute
    }

    private checkSchedules(onExecute: (id: string) => void) {
        const workflows = this.listWorkflows();
        const now = Date.now();

        workflows.forEach(wf => {
            if (!wf.active || !wf.schedule) return;

            const intervalMs = this.parseSchedule(wf.schedule);
            if (!intervalMs) return;

            const lastRun = wf.lastRun || 0;
            if (now - lastRun >= intervalMs) {
                console.log(`[WorkflowScheduler] Triggering scheduled workflow: ${wf.name} (${wf.id})`);
                onExecute(wf.id);
                // Update lastRun immediately to prevent double-firing
                // Note: Real execution might fail, but we assume it runs.
                this.updateLastRun(wf.id, now);
            }
        });
    }

    private parseSchedule(schedule: string): number | null {
        try {
            const lower = schedule.toLowerCase().trim();
            if (lower === '@daily') return 24 * 60 * 60 * 1000;
            if (lower === '@hourly') return 60 * 60 * 1000;

            // Format: "@every 5m" or "5m"
            const match = lower.match(/(@every\s+)?(\d+)\s*([mhd])/);
            if (match) {
                const value = parseInt(match[2]);
                const unit = match[3];
                let multiplier = 1000;
                if (unit === 'm') multiplier *= 60;
                if (unit === 'h') multiplier *= 60 * 60;
                if (unit === 'd') multiplier *= 24 * 60 * 60;
                return value * multiplier;
            }
            return null;
        } catch (e) {
            return null;
        }
    }
}
