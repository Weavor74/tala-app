# Service: WorkflowService.ts

**Source**: [electron\services\WorkflowService.ts](../../electron/services/WorkflowService.ts)

## Class: `WorkflowService`

## Overview
Represents a single saved workflow definition. Workflows are visual automation graphs consisting of interconnected nodes and edges, created in the WorkflowEditor component and executed by the WorkflowEngine service./
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

/** WorkflowService  Provides CRUD (Create, Read, Update, Delete) operations for workflow JSON files. Workflows are stored as individual `.json` files in the `.agent/workflows/` directory within the user's workspace.  This service handles persistence only — it does NOT execute workflows. Execution is handled by the `WorkflowEngine` service.  File storage format: ``` <workspace>/.agent/workflows/   ├── my-workflow.json   ├── daily-backup.json   └── code-review.json ```  Each JSON file contains a complete `WorkflowEntry` object with id, name, description, nodes, edges, and active flag.  @example ```typescript const workflowService = new WorkflowService('/path/to/workspace'); const workflows = workflowService.listWorkflows(); workflowService.saveWorkflow({ id: 'new-wf', name: 'New', description: '', nodes: [], edges: [], active: true }); ```

### Methods

#### `ensureDir`
Ensures the workflows directory exists on disk. Creates it recursively (including `.agent/` parent) if it doesn't exist. Called internally before any read/write operation.  @private @returns {void}/

**Arguments**: ``

---
#### `listWorkflows`
Lists all saved workflows by scanning the workflows directory for `.json` files.  For each JSON file found: 1. Reads and parses the file content. 2. Validates that it has at least an `id` and `nodes` property. 3. Adds valid entries to the result array. 4. Logs a warning and skips invalid files (malformed JSON, missing required fields).  @returns {WorkflowEntry[]} Array of valid workflow entries found on disk.   Returns an empty array if the directory doesn't exist, is empty, or   all files are invalid./

**Arguments**: ``
**Returns**: `WorkflowEntry[]`

---
#### `saveWorkflow`
Saves a workflow entry to disk as a JSON file.  The filename is derived from `workflow.id` after sanitizing it to remove any characters that are not alphanumeric, hyphens, or underscores. This prevents directory traversal attacks and filesystem issues.  If a file with the same ID already exists, it is overwritten (upsert behavior).  @param {WorkflowEntry} workflow - The workflow object to persist. @returns {boolean} `true` if the file was written successfully, `false` on error./

**Arguments**: `workflow: WorkflowEntry`
**Returns**: `boolean`

---
#### `deleteWorkflow`
Deletes a workflow JSON file from disk by its ID.  The ID is sanitized before constructing the file path to prevent directory traversal attacks. If the file doesn't exist, returns `false`.  @param {string} id - The unique identifier of the workflow to delete. @returns {boolean} `true` if the file was found and deleted, `false` if   the file didn't exist or an error occurred./

**Arguments**: `id: string`
**Returns**: `boolean`

---
#### `importFromUrl`
Imports workflow definitions from a remote URL.  Fetches JSON from the given URL and attempts to parse it as workflow data. Supports three input formats: 1. **Array of workflows**: `[{ id, nodes, ... }, ...]` 2. **Wrapper object**: `{ workflows: [{ id, nodes, ... }, ...] }` 3. **Single workflow**: `{ id, nodes, ... }`  Each valid workflow in the parsed data is saved to disk via `saveWorkflow()`. Invalid entries (missing `id` or `nodes`) are silently skipped.  @param {string} url - The URL to fetch workflow JSON from. Must return   valid JSON in one of the three supported formats. @returns {Promise<{ success: boolean; count: number; error?: string }>}   - `success` — `true` if the fetch and parse succeeded.   - `count` — Number of workflows successfully imported.   - `error` — (only on failure) Human-readable error message.  @example ```typescript const result = await workflowService.importFromUrl('https://example.com/workflows.json'); console.log(`Imported ${result.count} workflows`); ```/

**Arguments**: `url: string`
**Returns**: `Promise<`

---
#### `saveRun`
Persists a workflow execution run to disk.  Runs are stored in the `.agent/workflow_runs/` directory as JSON files. The filename follows the pattern `{workflowId}_{runId}.json`.  @param workflowId - The unique ID of the parent workflow. @param runId - A unique identifier for this specific execution (e.g., a timestamp). @param data - The result object containing success status, logs, and context./

**Arguments**: `workflowId: string, runId: string, data: any`

---
#### `listRuns`
Lists all execution runs for a specific workflow. Scans the `.agent/workflow_runs/` directory for files matching `${workflowId}_*.json`.  @param {string} workflowId - ID of the workflow. @returns {any[]} Array of run metadata (filename, id, timestamp, data)./

**Arguments**: `workflowId: string`
**Returns**: `any[]`

---
#### `deleteRun`
Deletes a specific workflow run record.  @param {string} workflowId - ID of the workflow. @param {string} runId - ID of the run to delete. @returns {boolean} `true` if deleted, `false` otherwise./

**Arguments**: `workflowId: string, runId: string`
**Returns**: `boolean`

---
#### `updateLastRun`
Updates the `lastRun` timestamp for a workflow definition.  Finds the workflow by ID, updates the timestamp in memory, and triggers  a `saveWorkflow()` to persist the change.  @param id - The workflow ID. @param timestamp - The epoch timestamp of the run./

**Arguments**: `id: string, timestamp: number`

---
#### `initScheduler`
Initializes the background workflow scheduler.  Starts a 60-second polling loop that calls `checkSchedules()`.  @param onExecute - Execution callback provided by the Main process to trigger a workflow./

**Arguments**: `onExecute: (id: string) => void`

---
#### `checkSchedules`
**Arguments**: `onExecute: (id: string) => void`

---
#### `exportWorkflowToPython`
Exports a workflow as a standalone Python codeset. Generates a self-contained Python package in `outputDir` with: - `manifest.json` — workflow metadata and node map - `workflow.json` — full node/edge definition - `workflow_runner.py` — BFS execution engine - `main.py` — CLI entrypoint - `nodes/` — individual node stub implementations - `Dockerfile` + `requirements.txt` + `README.md` @param workflowId - The ID of the workflow to export. @param outputDir - The absolute path to the directory to write files into./

**Arguments**: `workflowId: string, outputDir: string`
**Returns**: `Promise<boolean>`

---
#### `parseSchedule`
**Arguments**: `schedule: string`
**Returns**: `number | null`

---
