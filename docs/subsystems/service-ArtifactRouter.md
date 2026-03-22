# Service: ArtifactRouter.ts

**Source**: [electron/services/ArtifactRouter.ts](../../electron/services/ArtifactRouter.ts)

## Class: `ArtifactRouter`

## Overview
ArtifactRouter
 
 Deterministic output routing for agent turns.
 Decides whether content belongs in chat, workspace editor, browser, diff view,
 or another artifact surface. Routing decisions are recorded in audit telemetry
 so every turn has an inspectable record of where its output went.

 **Routing Priority:**
 1. Raw-content override (user requested in-chat display) → chat
 2. Tool result artifact resolution → workspace / browser / diff
 3. Message heuristics (HTML detection, length threshold) → workspace
 4. Default → chat

### Methods

#### `normalizeAgentOutput`
Normalizes agent output into a structured AgentTurnOutput.
 Decisions are based on content length, content type, and tool results.
 Routing decisions are emitted as audit telemetry.
/

**Arguments**: `message: string, toolResults?: any[], turnId?: string`
**Returns**: `AgentTurnOutput`

---
#### `emitRoutingAudit`
Emits structured audit telemetry for the routing decision.
/

**Arguments**: `turnId: string | undefined, channel: string, reason: string, artifact: WorkspaceArtifact | null | undefined`
**Returns**: `void`

---
#### `artifactTypeToChannel`
**Arguments**: `type: string`
**Returns**: `'chat' | 'workspace' | 'browser' | 'diff' | 'fallback'`

---
#### `resolveWorkspaceArtifact`
Resolves a tool execution result into a workspace artifact if applicable.
/

**Arguments**: `res: any`
**Returns**: `WorkspaceArtifact | null`

---
#### `resolveFromRawResult`
**Arguments**: `toolResult: any`
**Returns**: `WorkspaceArtifact | null`

---
#### `detectRawContentOverride`
Determines if the user explicitly asked for raw content in chat.
/

**Arguments**: `message: string`
**Returns**: `boolean`

---
#### `inferArtifactTypeFromPath`
Infers artifact type from a file path.
/

**Arguments**: `filePath: string, context?: any`
**Returns**: `ArtifactType`

---
#### `generateStableId`
Generates a stable unique ID based on target content or path.
 Prevents duplicate tabs for the same resource.
/

**Arguments**: `target: string, type: string`
**Returns**: `string`

---
#### `isLikelyHtml`
**Arguments**: `text: string`
**Returns**: `boolean`

---
#### `getArtifactSummary`
**Arguments**: `artifact: WorkspaceArtifact`
**Returns**: `string`

---
