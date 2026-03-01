# [TALA CAPABILITY GAP SCAN]
RunID: R-20260228-1830

Based on a deep audit of the ToolService, AgentService, and connected MCP servers, the following 10 gaps have been identified:

1. **Broken A2UI Integration**: The A2UI protocol was being misused and causing argument parsing errors.
   - *Fix Step*: Completely remove A2UI and replace visual goals with plain text or Markdown tables in chat. (COMPLETED)

2. **Astro Engine Schema Mismatch**: The `get_raw_agent_emotional_state` tool expects `mood_label` but `EmotionResponse` does not provide it.
   - *Fix Step*: Update `astro_emotion_engine/schemas/response.py` to include `mood_label` or remove the reference in `mcp_server.py`.

3. **Mem0 Inference Dependency**: Mem0 is hardcoded to use `llama3` for memory extraction, but the user's Ollama instance lacks it.
   - *Fix Step*: Update `mem0-core/server.py` to use a flexible model ID from settings or a widely available one naturally.

4. **Venv Detection Scope**: `SystemService` misses venvs located in the app root when the app is started with `data/workspace` as the primary workspace.
   - *Fix Step*: Enhance `SystemService.detectEnv` to always check the `app.getAppPath()` for a `venv` or `mcp-servers/tala-core/venv`.

5. **Silent Ignite Failures**: MCP server ignition failures in `AgentService.igniteSoul` are logged to console but not to the persistent `audit-log.jsonl`.
   - *Fix Step*: Wrap ignite tasks with `auditLogger.error` calls to ensure provability of startup failures.

6. **Missing Automated Diagnostics**: There is no tool to verify MCP health besides manually calling them.
   - *Fix Step*: Add an `mcp_health_check` tool to `ToolService` that pings all active connections.

7. **UI Visibility of Soul State**: The user has no easy way to see if Astro, Memory, or RAG engines are offline.
   - *Fix Step*: Create an IPC channel `system:soul-status` to push `isSoulReady` and server states to the React frontend.

8. **Generic Routing Rationale**: `SmartRouter` uses hardcoded strings like "Simple task detected" which lack numerical proof.
   - *Fix Step*: Update `SmartRouterService` to include token count estimates or cost deltas in the rationale.

9. **No Self-Healing for MCP**: If a Python server crashes, there's no way to restart it without restarting the whole app.
   - *Fix Step*: Implement a `restart_soul` tool in `AgentService` that kills existing processes and re-runs `igniteSoul`.

10. **A2UI Leftovers in Renderers**: While the React component was removed, there may be global CSS or layout offsets still reserved for the A2UI panel.
    - *Fix Step*: Run a recursive grep for `a2ui` in `src/renderer` and purge any remaining CSS variables or padding configurations.
