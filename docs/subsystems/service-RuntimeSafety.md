# Service: RuntimeSafety.ts

**Source**: [electron\services\RuntimeSafety.ts](../../electron/services/RuntimeSafety.ts)

## Class: `RuntimeSafety`

## Overview
Agent Behavioral Monitoring & Safety System.  The `RuntimeSafety` service monitors the agent's actions in real-time to  detect and prevent unintended behaviors, such as infinite loops, redundant  tool calls, or duplicate memory persistence.  **Core Responsibilities:** - **Tool Cooldowns**: Enforces a minimum time between repetitive tool calls. - **Loop Detection**: Monitors the last several assistant responses for exact    or near-exact string matches to identify stalled reasoning loops. - **Duplicate Memory Prevention**: Uses hashing to ensure the agent doesn't    write the same "fact" multiple times in a short window. - **Context Throttling**: Limits the history of recorded tool executions to    maintain high performance.

### Methods

#### `recordToolExecution`
Records a tool execution for loop and cooldown monitoring.  Maintains a rolling window of the last 10 executions per tool. This  metadata is used by `AgentService` to determine if a turn should be  throttled or if the agent is stuck in a repetitive cycle.  @param toolName - The identifier of the tool being executed./

**Arguments**: `toolName: string`
**Returns**: `void`

---
#### `isToolCooldownActive`
Checks if a tool is within its cooldown period./

**Arguments**: `toolName: string`
**Returns**: `boolean`

---
#### `checkResponseLoop`
Detects repetitive string patterns in the assistant's dialogue.  Maintains a rolling window of `MAX_RESPONSES` (default 5). If the  current normalized response appears `LOOP_THRESHOLD` (default 3) times  within that window, a loop is signaled.  @param text - The latest text response from the agent. @returns True if a repetitive loop is detected./

**Arguments**: `text: string`
**Returns**: `boolean`

---
#### `isDuplicateMemory`
Checks if memory content is a duplicate of something recently written./

**Arguments**: `text: string`
**Returns**: `boolean`

---
#### `hashText`
**Arguments**: `text: string`
**Returns**: `string`

---
#### `reset`
**Arguments**: ``
**Returns**: `void`

---
