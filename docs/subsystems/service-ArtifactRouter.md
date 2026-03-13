# Service: ArtifactRouter.ts

**Source**: [electron\services\ArtifactRouter.ts](../../electron/services/ArtifactRouter.ts)

## Class: `ArtifactRouter`

## Overview
ArtifactRouter  Logic to decide whether content belongs in chat or in the workspace. Prevents large documents and technical assets from flooding chat.

### Methods

#### `normalizeAgentOutput`
Normalizes agent output into a structured AgentTurnOutput. Decisions are based on content length, content type, and tool results./

**Arguments**: `message: string, toolResults?: any[]`
**Returns**: `AgentTurnOutput`

---
#### `resolveWorkspaceArtifact`
Resolves a tool execution result into a workspace artifact if applicable./

**Arguments**: `res: any`
**Returns**: `WorkspaceArtifact | null`

---
#### `resolveFromRawResult`
**Arguments**: `toolResult: any`
**Returns**: `WorkspaceArtifact | null`

---
#### `detectRawContentOverride`
Determines if the user explicitly asked for raw content in chat./

**Arguments**: `message: string`
**Returns**: `boolean`

---
#### `inferArtifactTypeFromPath`
Infers artifact type from a file path./

**Arguments**: `filePath: string, context?: any`
**Returns**: `ArtifactType`

---
#### `generateStableId`
Generates a stable unique ID based on target content or path. Prevents duplicate tabs for the same resource./

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
