# Service: AstroService.ts

**Source**: [electron/services/AstroService.ts](../../electron/services/AstroService.ts)

## Class: `AstroService`

## Overview
AstroService
 
 Manages the lifecycle and communication with the embedded Astro Emotion Engine
 MCP server. This service is responsible for calculating Tala's real-time
 emotional state based on astrological natal chart data and current planetary transits.
 
 **How it integrates with the agent:**
 During each conversation turn, `AgentService.chat()` calls `getEmotionalState()`
 to inject an `[ASTRO STATE]` block into the system prompt. This block contains:
 - **System Instructions**: Personality modifiers based on current planetary energy.
 - **Style Guide**: Communication tone guidance (e.g., "Be more nurturing today").
 - **Emotional Vector**: Numeric scores for dimensions like warmth, intensity, clarity.
 
 **Architecture:**
 The service spawns the Astro Engine as a Python child process and communicates
 via the MCP SDK's stdio transport. The engine uses Swiss Ephemeris for planetary
 position calculations and runs 13 planetary modules to produce the emotional state.
 
 **Lifecycle:**
 1. `ignite()` — Spawns the Python process and connects the MCP client.
 2. `getEmotionalState()` — Called per chat turn to get current emotional modulation.
 3. `shutdown()` — Kills the Python process during app closure.
 
 @example
 ```typescript
 const astro = new AstroService();
 await astro.ignite('/path/to/python', '/path/to/astro-engine');
 const state = await astro.getEmotionalState('tala', 'User is asking about career');
 console.log(state); // "[ASTRO STATE]\nSystem Instructions: ..."
 ```

### Methods

#### `getReadyStatus`
**Arguments**: ``
**Returns**: `boolean`

---
#### `ignite`
Spawns the Astro Emotion Engine as a Python child process and connects
 the MCP client to it via stdio transport.
 
 This method performs two parallel operations:
 1. **Spawns a debug process**: A child process that captures stdout/stderr
    output to a log file at `{userData}/astro_engine.log` for debugging.
 2. **Creates an MCP transport**: A separate `StdioClientTransport` that
    the MCP SDK uses for bidirectional tool-call communication.
 
 The engine is started with:
 - `python -m astro_emotion_engine.mcp_server` (module execution mode).
 - `PYTHONUNBUFFERED=1` to ensure real-time log output.
 - `ASTRO_FORCE_FALLBACK=1` to use the fallback ephemeris provider if
   Swiss Ephemeris data files are not available.
 
 On success, `isReady` is set to `true` and subsequent tool calls are enabled.
 On failure, the error is re-thrown to the caller (AgentService).
 
 @param {string} pythonPath - Absolute path to the Python executable
   (typically from the venv: `mcp-servers/tala-core/venv/Scripts/python.exe`).
 @param {string} scriptPath - Absolute path to the astro-engine package directory
   (e.g., `mcp-servers/astro-engine/astro_emotion_engine/`). Used as the `cwd`
   for the spawned process (the parent directory of the package).
 @returns {Promise<void>}
 @throws {Error} If the MCP connection fails (e.g., Python not found, import errors).
/

**Arguments**: `pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}`
**Returns**: `Promise<void>`

---
#### `getEmotionalState`
Retrieves the current astrological emotional state for a given agent profile.
 
 Calls the `get_emotional_state` MCP tool on the connected Astro Engine,
 which runs the full calculation pipeline:
 1. Loads the agent's natal chart data from their stored profile.
 2. Calculates current planetary positions using the ephemeris provider.
 3. Runs all 13 planetary modules (Moon phase, Mercury, Venus, Mars, etc.).
 4. Aggregates scores into a normalized emotional vector.
 5. Generates system instructions, style guide, and mood label.
 
 The returned string is formatted as an `[ASTRO STATE]` block that gets
 injected into the agent's system prompt by `AgentService.chat()`.
 
 If the engine is not ready (not ignited or crashed), returns a neutral
 fallback state instead of throwing, so the agent can still function.
 
 @param {string} [agentId='tala'] - The agent profile ID. Must match a profile
   previously created via `createProfile()` or stored in `agent_profiles.json`.
 @param {string} [contextPrompt=''] - Optional context about the current
   interaction (e.g., `'User is asking about relationships'`). Used by the
   engine to fine-tune the emotional output for the conversation topic.
 @returns {Promise<string>} Formatted emotional state string, prefixed with
   `[ASTRO STATE]`. Contains system instructions, style guide, emotional vector,
   and mood label. Returns a fallback string if the engine is offline.
/

**Arguments**: `agentId: string = 'tala', contextPrompt: string = ''`
**Returns**: `Promise<string>`

---
#### `getRawEmotionalState`
Retrieves the raw emotional vector and mood label.
/

**Arguments**: `agentId: string = 'tala'`
**Returns**: `Promise<any>`

---
#### `createProfile`
Creates a new agent profile in the Astro Engine's persistent profile store.
/

**Arguments**: `agentId: string, name: string, birthDate: string, birthPlace: string`
**Returns**: `Promise<string>`

---
#### `listProfiles`
Retrieves a formatted list of all agent profiles stored in the Astro Engine.
/

**Arguments**: ``
**Returns**: `Promise<string>`

---
#### `updateProfile`
Updates an existing agent profile in the Astro Engine.
/

**Arguments**: `agentId: string, name?: string, birthDate?: string, birthPlace?: string`
**Returns**: `Promise<string>`

---
#### `deleteProfile`
Deletes an agent profile from the Astro Engine.
/

**Arguments**: `agentId: string`
**Returns**: `Promise<string>`

---
