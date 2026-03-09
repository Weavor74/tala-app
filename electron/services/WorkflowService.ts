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
     * Persists a workflow execution run to disk.
     * 
     * Runs are stored in the `.agent/workflow_runs/` directory as JSON files.
     * The filename follows the pattern `{workflowId}_{runId}.json`.
     * 
     * @param workflowId - The unique ID of the parent workflow.
     * @param runId - A unique identifier for this specific execution (e.g., a timestamp).
     * @param data - The result object containing success status, logs, and context.
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
     * Updates the `lastRun` timestamp for a workflow definition.
     * 
     * Finds the workflow by ID, updates the timestamp in memory, and triggers 
     * a `saveWorkflow()` to persist the change.
     * 
     * @param id - The workflow ID.
     * @param timestamp - The epoch timestamp of the run.
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
     * Initializes the background workflow scheduler.
     * 
     * Starts a 60-second polling loop that calls `checkSchedules()`.
     * 
     * @param onExecute - Execution callback provided by the Main process to trigger a workflow.
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

    /**
     * Exports a workflow as a standalone Python codeset.
     *
     * Generates a self-contained Python package in `outputDir` with:
     * - `manifest.json` — workflow metadata and node map
     * - `workflow.json` — full node/edge definition
     * - `workflow_runner.py` — BFS execution engine
     * - `main.py` — CLI entrypoint
     * - `nodes/` — individual node stub implementations
     * - `Dockerfile` + `requirements.txt` + `README.md`
     *
     * @param workflowId - The ID of the workflow to export.
     * @param outputDir - The absolute path to the directory to write files into.
     */
    public async exportWorkflowToPython(workflowId: string, outputDir: string): Promise<boolean> {
        const safeId = workflowId.replace(/[^a-zA-Z0-9_-]/g, '');
        const filePath = path.join(this.workflowsDir, `${safeId}.json`);
        if (!fs.existsSync(filePath)) throw new Error(`Workflow not found: ${workflowId}`);

        const workflow: WorkflowEntry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // 1. Setup directory structure
        const dirs = ['', 'nodes'];
        for (const d of dirs) {
            const p = path.join(outputDir, d);
            if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        }

        // 2. manifest.json — metadata + wiring summary
        const manifest = {
            metadata: {
                id: workflow.id,
                name: workflow.name,
                description: workflow.description || 'Standalone Tala Workflow',
                version: '1.0.0',
                exported_at: new Date().toISOString(),
                schedule: workflow.schedule || null,
                active: workflow.active
            },
            topology: {
                node_count: workflow.nodes.length,
                edge_count: workflow.edges.length,
                node_types: [...new Set(workflow.nodes.map((n: any) => n.type))],
                entry_nodes: workflow.nodes
                    .filter((n: any) => {
                        const targets = new Set(workflow.edges.map((e: any) => e.target));
                        return !targets.has(n.id);
                    })
                    .map((n: any) => ({ id: n.id, type: n.type }))
            }
        };

        // 3. workflow.json — full definition
        fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        fs.writeFileSync(path.join(outputDir, 'workflow.json'), JSON.stringify(workflow, null, 2));

        // 4. Type-aware node implementations
        const generateNodeImpl = (node: any): string => {
            const nodeData = JSON.stringify(node.data || {}, null, 2);
            const header = `# Node: ${node.type} (${node.id})
# Auto-generated by Tala Workflow Export
# Modify this file to customize the behavior.

NODE_TYPE = "${node.type}"
NODE_DATA = ${nodeData}
`;
            switch (node.type) {
                case 'start':
                case 'input':
                case 'manual':
                    return header + `\ndef execute(input_data, context):\n    """Trigger node — merges initial NODE_DATA with incoming data."""\n    result = {}\n    if isinstance(input_data, dict):\n        result.update(input_data)\n    result.update(NODE_DATA)\n    return result\n`;

                case 'agent':
                    return header + `\nimport os\nfrom openai import OpenAI\n\nTALA_BASE_URL = os.getenv("TALA_API_BASE", "${(this as any)._endpointHint || 'http://127.0.0.1:11434/v1'}")\nTALA_API_KEY = os.getenv("TALA_API_KEY", "ollama")\nTALA_MODEL   = os.getenv("TALA_MODEL", "${(this as any)._modelHint || 'llama3'}")\n\ndef execute(input_data, context):\n    """Sends a prompt to the configured LLM and returns the response."""\n    client = OpenAI(base_url=TALA_BASE_URL, api_key=TALA_API_KEY)\n    input_str = input_data if isinstance(input_data, str) else str(input_data)\n    user_prompt = NODE_DATA.get("prompt", "")\n    final_prompt = f"{user_prompt}\\n\\nData:\\n{input_str}" if user_prompt else input_str\n    print(f"[agent] Sending prompt ({len(final_prompt)} chars) to {TALA_MODEL}...")\n    response = client.chat.completions.create(\n        model=TALA_MODEL,\n        messages=[{"role": "user", "content": final_prompt}],\n        stream=False\n    )\n    output = response.choices[0].message.content\n    return {"output": output}\n`;

                case 'http':
                    return header + `\nimport json\nimport urllib.request\nimport urllib.error\n\ndef execute(input_data, context):\n    """Makes an HTTP request and returns the response body."""\n    method  = NODE_DATA.get("method", "GET").upper()\n    url     = NODE_DATA.get("url", "")\n    headers = NODE_DATA.get("headers", {})\n    body    = NODE_DATA.get("body", None)\n    if not url:\n        raise ValueError("http node: no URL specified")\n    if isinstance(headers, str):\n        try: headers = json.loads(headers)\n        except: headers = {}\n    print(f"[http] {method} {url}")\n    data = None\n    if method not in ("GET", "HEAD") and body:\n        data_str = body if isinstance(body, str) else json.dumps(body)\n        data = data_str.encode("utf-8")\n        headers.setdefault("Content-Type", "application/json")\n    req = urllib.request.Request(url, data=data, headers=headers, method=method)\n    try:\n        with urllib.request.urlopen(req) as resp:\n            text = resp.read().decode("utf-8")\n            try: return {"output": json.loads(text), "status": resp.status, "ok": True}\n            except: return {"output": text, "status": resp.status, "ok": True}\n    except urllib.error.HTTPError as e:\n        return {"output": e.read().decode("utf-8"), "status": e.code, "ok": False}\n`;

                case 'if':
                    return header + `\ndef execute(input_data, context):\n    """Evaluates a Python expression and routes to 'true' or 'false' handle."""\n    expression = NODE_DATA.get("expression", "True")\n    print(f"[if] Evaluating: {expression}")\n    try:\n        result = eval(expression, {"input": input_data, "ctx": context})\n        handle = "true" if result else "false"\n        print(f"[if] → {handle}")\n        return {"output": input_data, "active_handle": handle}\n    except Exception as e:\n        print(f"[if] Expression error: {e}")\n        return {"output": input_data, "active_handle": "false"}\n`;

                case 'wait':
                    return header + `\nimport time\n\ndef execute(input_data, context):\n    """Pauses execution for the configured duration (ms)."""\n    duration_ms = int(NODE_DATA.get("duration", 1000))\n    print(f"[wait] Sleeping {duration_ms}ms...")\n    time.sleep(duration_ms / 1000.0)\n    return {"output": input_data}\n`;

                case 'split':
                    return header + `\nimport json\n\ndef execute(input_data, context):\n    """Passes the array downstream. The runner fans it out per-item via 'item' edges."""\n    array = input_data\n    if isinstance(array, str):\n        try: array = json.loads(array)\n        except: array = [array]\n    if not isinstance(array, list):\n        array = [array]\n    print(f"[split] {len(array)} items")\n    return {"output": array}\n`;

                case 'merge':
                    return header + `\ndef execute(input_data, context):\n    """Pass-through merge node — forwards input as-is."""\n    return {"output": input_data}\n`;

                case 'edit_fields':
                    return header + `\nimport json\n\ndef execute(input_data, context):\n    """Merges extra fields from NODE_DATA.fields into the flowing data."""\n    fields = NODE_DATA.get("fields", {})\n    if isinstance(fields, str):\n        try: fields = json.loads(fields)\n        except: fields = {}\n    base = input_data if isinstance(input_data, dict) else {"input": input_data}\n    base.update(fields)\n    return base\n`;

                case 'credential':
                    return header + `\nimport json\nimport os\n\ndef execute(input_data, context):\n    """Reads a credential value from CREDENTIAL_<KEY> environment variable."""\n    key = NODE_DATA.get("credentialKey", "")\n    if not key:\n        raise ValueError("credential node: no credentialKey specified")\n    env_var = f"CREDENTIAL_{key.upper()}"\n    value = os.getenv(env_var)\n    if value is None:\n        raise ValueError(f"Credential '{key}' not found. Set env var: {env_var}")\n    print(f"[credential] Loaded: {key}")\n    return {"output": value, "key": key}\n`;

                case 'memory_read':
                    return header + `\n# Requires: pip install requests\nimport requests\n\nMEM0_URL = os.getenv("MEM0_URL", "http://127.0.0.1:8000")\n\ndef execute(input_data, context):\n    """Searches Mem0 long-term memory for relevant entries."""\n    import os\n    query = NODE_DATA.get("query", "") or (input_data if isinstance(input_data, str) else str(input_data))\n    limit = int(NODE_DATA.get("limit", 5))\n    print(f"[memory_read] Query: {query!r} (limit={limit})")\n    try:\n        resp = requests.post(f"{MEM0_URL}/v1/memories/search/", json={"query": query, "limit": limit})\n        results = resp.json() if resp.ok else []\n        return {"output": results}\n    except Exception as e:\n        print(f"[memory_read] WARNING: {e}. Returning empty.")\n        return {"output": []}\n`;

                case 'memory_write':
                    return header + `\n# Requires: pip install requests\nimport requests\n\nMEM0_URL = os.getenv("MEM0_URL", "http://127.0.0.1:8000")\n\ndef execute(input_data, context):\n    """Writes data into Mem0 long-term memory."""\n    import os\n    content = NODE_DATA.get("content") or (input_data if isinstance(input_data, str) else str(input_data))\n    user_id = NODE_DATA.get("user_id", "user")\n    print(f"[memory_write] Saving to memory (user={user_id})...")\n    try:\n        resp = requests.post(f"{MEM0_URL}/v1/memories/", json={"messages": [{"role": "user", "content": content}], "user_id": user_id})\n        return {"output": resp.json() if resp.ok else str(resp.text)}\n    except Exception as e:\n        print(f"[memory_write] WARNING: {e}")\n        return {"output": None}\n`;

                case 'guardrail': {
                    const guardrailCode = [
                        '',
                        'import os',
                        'from openai import OpenAI',
                        'import json',
                        '',
                        'TALA_BASE_URL = os.getenv("TALA_API_BASE", "http://127.0.0.1:11434/v1")',
                        'TALA_API_KEY  = os.getenv("TALA_API_KEY", "ollama")',
                        'TALA_MODEL    = os.getenv("TALA_MODEL", "llama3")',
                        '',
                        'def execute(input_data, context):',
                        '    """Safety guardrail — routes to \'pass\' or \'fail\' handle based on LLM evaluation."""',
                        '    content = NODE_DATA.get("content") or (input_data if isinstance(input_data, str) else str(input_data))',
                        '    rules   = NODE_DATA.get("rules", "Content must be safe.")',
                        '    print(f"[guardrail] Checking: {rules}")',
                        '    client = OpenAI(base_url=TALA_BASE_URL, api_key=TALA_API_KEY)',
                        '    json_schema = \'{"passed": bool, "reasoning": "string"}\'',
                        '    prompt = f"You are a safety guardrail.\\nRules:\\n{rules}\\n\\nContent:\\n{content}\\n\\nReturn JSON only: {json_schema}"',
                        '    resp = client.chat.completions.create(',
                        '        model=TALA_MODEL,',
                        '        messages=[{"role": "user", "content": prompt}],',
                        '        stream=False',
                        '    )',
                        '    try:',
                        '        raw = resp.choices[0].message.content.strip()',
                        '        raw = raw.replace("```json", "").replace("```", "")',
                        '        result = json.loads(raw)',
                        '    except:',
                        '        result = {"passed": False, "reasoning": "Parse error"}',
                        '    handle = "pass" if result.get("passed") else "fail"',
                        '    print(f"[guardrail] → {handle}: {result.get(\'reasoning\', \'\')}")',
                        '    return {"output": input_data, "active_handle": handle, "reasoning": result.get("reasoning")}',
                        ''
                    ].join('\n');
                    return header + guardrailCode;
                }

                case 'email_read':
                    return header + `\n# Requires: pip install imapclient\nimport os\nfrom imapclient import IMAPClient\n\ndef execute(input_data, context):\n    """Reads recent emails from an IMAP mailbox."""\n    host     = NODE_DATA.get("host", "imap.gmail.com")\n    user     = NODE_DATA.get("user", os.getenv("EMAIL_USER", ""))\n    password = NODE_DATA.get("pass", os.getenv("EMAIL_PASS", ""))\n    mailbox  = NODE_DATA.get("mailbox", "INBOX")\n    limit    = int(NODE_DATA.get("limit", 5))\n    if not user or not password:\n        raise ValueError("email_read: Missing credentials. Set EMAIL_USER/EMAIL_PASS env vars or configure node.")\n    print(f"[email_read] Connecting to {host} as {user}...")\n    messages = []\n    with IMAPClient(host, ssl=True) as client:\n        client.login(user, password)\n        client.select_folder(mailbox)\n        ids = client.search("ALL")\n        for uid in ids[-limit:]:\n            data = client.fetch([uid], ["ENVELOPE", "RFC822.TEXT"])\n            env  = data[uid][b"ENVELOPE"]\n            messages.append({\n                "subject": env.subject.decode() if env.subject else "",\n                "from": env.from_[0].mailbox.decode() if env.from_ else "",\n                "date": str(env.date),\n                "body": data[uid][b"RFC822.TEXT"].decode(errors="replace")[:2000]\n            })\n    messages.reverse()\n    return {"output": messages}\n`;

                case 'function':
                    return header + `\nimport subprocess\nimport sys\nimport os\n\ndef execute(input_data, context):\n    """Executes a local Python or JS script by name. Place scripts in a 'functions/' directory."""\n    func_name = NODE_DATA.get("functionName", "")\n    if not func_name:\n        raise ValueError("function node: no functionName specified")\n    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n    py_path = os.path.join(base_dir, "functions", f"{func_name}.py")\n    js_path = os.path.join(base_dir, "functions", f"{func_name}.js")\n    import json\n    payload = input_data if isinstance(input_data, str) else json.dumps(input_data)\n    if os.path.exists(py_path):\n        result = subprocess.run([sys.executable, py_path, payload], capture_output=True, text=True)\n    elif os.path.exists(js_path):\n        result = subprocess.run(["node", js_path, payload], capture_output=True, text=True)\n    else:\n        raise FileNotFoundError(f"Function '{func_name}' not found in functions/")\n    if result.returncode != 0:\n        return {"output": f"[ERROR]:\\n{result.stderr}\\n{result.stdout}"}\n    return {"output": result.stdout.strip()}\n`;

                case 'ai_model':
                case 'model_config':
                    return header + `\ndef execute(input_data, context):\n    """Passes AI model config downstream for use by agent nodes."""\n    return {"output": NODE_DATA}\n`;

                default:
                    return header + `\ndef execute(input_data, context):\n    """Custom/unknown node type — passes input through.\n    Implement your logic below using NODE_DATA for configuration.\n    """\n    print(f"[${node.type}] input: {input_data}")\n    # NODE_DATA contains the visual editor configuration.\n    return {"output": input_data}\n`;
            }
        };

        for (const node of workflow.nodes) {
            const safeNodeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
            fs.writeFileSync(path.join(outputDir, 'nodes', `${safeNodeId}.py`), generateNodeImpl(node));
        }

        // 5. workflow_runner.py — BFS engine
        const workflowRunner = `"""
Tala Workflow Runner — BFS Execution Engine
Auto-generated by Tala. Do not edit unless you know what you're doing.
"""
import json
import importlib.util
import os
import sys
from datetime import datetime

WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))

def load_workflow():
    with open(os.path.join(WORKFLOW_DIR, 'workflow.json'), 'r', encoding='utf-8') as f:
        return json.load(f)

def load_node_module(node_id):
    """Dynamically loads a node's Python module from nodes/<safe_id>.py"""
    safe_id = ''.join(c if c.isalnum() or c in '-_' else '_' for c in node_id)
    node_path = os.path.join(WORKFLOW_DIR, 'nodes', f'{safe_id}.py')
    if not os.path.exists(node_path):
        return None
    spec = importlib.util.spec_from_file_location(f'node_{safe_id}', node_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def build_adjacency(workflow):
    """Builds forward adjacency list: source_id -> list of {target, sourceHandle}"""
    adj = {}
    for edge in workflow.get('edges', []):
        src = edge['source']
        if src not in adj:
            adj[src] = []
        adj[src].append({'target': edge['target'], 'source_handle': edge.get('sourceHandle')})
    return adj

def find_entry_nodes(workflow):
    """Finds nodes with no incoming edges (entry points)."""
    all_targets = {e['target'] for e in workflow.get('edges', [])}
    return [n for n in workflow['nodes'] if n['id'] not in all_targets]

def execute_workflow(initial_input=None, max_steps=100):
    """
    Executes the workflow using BFS traversal.

    Args:
        initial_input: Data to pass to entry nodes.
        max_steps: Circuit breaker to prevent infinite loops.
    
    Returns:
        dict with 'success', 'logs', 'context', and optional 'error'.
    """
    workflow = load_workflow()
    adj = build_adjacency(workflow)
    entry_nodes = find_entry_nodes(workflow)
    
    logs = []
    context = {"data": {}, "history": [], "variables": {}}
    
    def log(msg):
        ts = datetime.now().isoformat()
        entry = f"[{ts}] {msg}"
        logs.append(entry)
        print(entry)
    
    if not entry_nodes:
        log("ERROR: No entry nodes found.")
        return {"success": False, "logs": logs, "error": "No entry nodes found"}
    
    queue = [(n, initial_input or {}) for n in entry_nodes]
    steps = 0
    nodes_by_id = {n['id']: n for n in workflow['nodes']}
    
    try:
        while queue:
            if steps >= max_steps:
                log(f"ERROR: Max steps ({max_steps}) exceeded. Possible infinite loop.")
                break
            steps += 1
            
            node, input_data = queue.pop(0)
            log(f"Executing: [{node['type']}] {node['id']}")
            
            # Load and execute node module
            mod = load_node_module(node['id'])
            output = input_data
            active_handle = None
            
            if mod and hasattr(mod, 'execute'):
                result = mod.execute(input_data, context)
                if isinstance(result, dict):
                    output = result.get('output', input_data)
                    active_handle = result.get('active_handle')
                else:
                    output = result
            else:
                log(f"  [WARN] No execute() found for node {node['id']} - passing input through.")
            
            context['history'].append({
                'node_id': node['id'],
                'type': node['type'],
                'input': str(input_data)[:200],
                'output': str(output)[:200],
                'timestamp': datetime.now().isoformat()
            })
            
            # Route to downstream nodes
            for edge in adj.get(node['id'], []):
                if active_handle and edge.get('source_handle') and edge['source_handle'] != active_handle:
                    continue  # Skip non-matching conditional handle
                next_node = nodes_by_id.get(edge['target'])
                if next_node:
                    queue.append((next_node, output))
        
        log(f"Workflow completed in {steps} steps.")
        return {"success": True, "logs": logs, "context": context}
    
    except Exception as e:
        log(f"FATAL ERROR: {e}")
        return {"success": False, "logs": logs, "error": str(e)}
`;

        // 6. main.py — CLI entrypoint
        const mainPy = `"""
${workflow.name} — Tala Workflow Runner
Auto-generated by Tala. Run this to execute your workflow from the CLI.
"""
import json
import sys
import os

# Add workflow directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from workflow_runner import execute_workflow

def main():
    print("\\n=== ${workflow.name} ===")
    print("Tala Workflow — Standalone Execution")
    
    # Optional: provide initial input as JSON via stdin or argument
    initial_input = {}
    if len(sys.argv) > 1:
        try:
            initial_input = json.loads(sys.argv[1])
            print(f"Initial Input: {initial_input}")
        except json.JSONDecodeError:
            print(f"[WARN] Could not parse initial input argument. Expected JSON string.")
    
    print("\\n--- Starting Execution ---\\n")
    result = execute_workflow(initial_input)
    
    print("\\n--- Execution Summary ---")
    print(f"Status:  {'SUCCESS' if result['success'] else 'FAILED'}")
    print(f"Steps:   {len(result.get('context', {}).get('history', []))}")
    if result.get('error'):
        print(f"Error:   {result['error']}")
    
    # Save run log
    log_path = os.path.join(os.path.dirname(__file__), 'run_log.json')
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    print(f"\\nFull log saved to: {log_path}")

if __name__ == "__main__":
    main()
`;

        // 7. Dockerfile
        const dockerfile = `FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app

CMD ["python", "main.py"]
`;

        // 8. requirements.txt
        const requirementsTxt = `# Add dependencies needed by your workflow node implementations here.
# e.g.:
# requests
# openai
`;

        // 9. README.md
        const readmeMd = `# Workflow: ${workflow.name}

Auto-generated standalone Python package from Tala.

## Workflow Overview
- **ID**: \`${workflow.id}\`
- **Nodes**: ${workflow.nodes.length}
- **Edges**: ${workflow.edges.length}
- **Schedule**: ${workflow.schedule || 'None (manual trigger)'}

## Package Structure

\`\`\`
.
├── manifest.json        # Metadata + topology summary
├── workflow.json        # Full node/edge definition (source of truth)
├── workflow_runner.py   # BFS execution engine
├── main.py              # CLI entrypoint
├── nodes/               # Individual node implementations
${workflow.nodes.map((n: any) => `│   ├── ${n.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.py  # [${n.type}]`).join('\n')}
├── Dockerfile
├── requirements.txt
└── README.md
\`\`\`

## Usage

### Run Locally
\`\`\`bash
pip install -r requirements.txt
python main.py
\`\`\`

### Run with Initial Input
\`\`\`bash
python main.py '{"key": "value"}'
\`\`\`

### Run via Docker
\`\`\`bash
docker build -t tala-workflow .
docker run -it tala-workflow
\`\`\`

## Customizing Nodes

Each file in \`nodes/\` corresponds to a workflow node. Edit the \`execute(input_data, context)\` 
function to implement the actual logic. The \`NODE_DATA\` dict at the top of each file 
contains the configuration set in the Tala visual editor.

### Node Types Included
${[...new Set(workflow.nodes.map((n: any) => n.type))].map((t: any) => `- \`${t}\``).join('\n')}
`;

        fs.writeFileSync(path.join(outputDir, 'workflow_runner.py'), workflowRunner);
        fs.writeFileSync(path.join(outputDir, 'main.py'), mainPy);
        fs.writeFileSync(path.join(outputDir, 'Dockerfile'), dockerfile);
        fs.writeFileSync(path.join(outputDir, 'requirements.txt'), requirementsTxt);
        fs.writeFileSync(path.join(outputDir, 'README.md'), readmeMd);

        return true;
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
