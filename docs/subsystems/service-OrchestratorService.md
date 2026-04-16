# Service: OrchestratorService.ts

**Source**: [electron/services/OrchestratorService.ts](../../electron/services/OrchestratorService.ts)

## Class: `OrchestratorService`

## Overview
Agentic Orchestrator Service
 
 Manages background AI sub-agents ("Minions") for autonomous task execution.
 It extracts the core agentic tool-use loop into a headless version that can
 reason and act without direct UI side-effects or persistent session pollution.
 
 **Usage Context:**
 - Used for parallel background tasks (e.g., code analysis, log filtering).
 - Provides a "Headless Loop" that simulates the agent's main decision cycle.
 - Handles recursive tool execution and multi-turn reasoning cycles.

### Methods

#### `setBrain`
Updates the active brain instance.
/

**Arguments**: `brain: IBrain`

---
#### `runHeadlessLoop`
Runs a multi-turn tool-use loop in the background.
 
 @param prompt The goal/task for the sub-agent.
 @param systemPrompt The persona/instructions for the sub-agent.
 @param maxTurns Maximum number of tool-use cycles (default 5).
 @returns The final text response from the sub-agent.
/

**Arguments**: `prompt: string, systemPrompt: string, maxTurns: number = 5`
**Returns**: `Promise<string>`

---
