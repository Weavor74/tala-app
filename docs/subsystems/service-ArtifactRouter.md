# Service: ArtifactRouter.ts

**Source**: [electron/services/ArtifactRouter.ts](../../electron/services/ArtifactRouter.ts)

## Class: `ArtifactRouter`

## Overview

Deterministic output routing for agent turns. Decides whether content belongs in chat,
workspace editor, browser, diff view, or another artifact surface. Routing decisions are
recorded in audit telemetry so every turn has an inspectable record of where its output went.

## Routing Priority (Phase 1 Hardened)

1. **Raw-content override** (user requested in-chat display) → `chat`
2. **Tool result artifact resolution** → `workspace` / `browser` / `diff`
3. **Message heuristics** (HTML detection, length > 2000) → `workspace` / `browser`
4. **Default** → `chat`

## Routing Decision Table

| Trigger | Output Channel | routingReason |
|---------|---------------|---------------|
| User override phrases ("paste it here", "show raw", etc.) | `chat` | `raw_content_override` |
| `fs_read_text` tool result | `workspace` | `tool_result` |
| `browser_navigate` tool result | `browser` | `tool_result` |
| Message length > 2000 chars | `workspace` | `length_threshold` |
| HTML message detected | `browser` | `html_heuristic` |
| Default | `chat` | `default` |

## AgentTurnOutput Fields (Phase 1 Hardened)

Every `normalizeAgentOutput()` call returns an `AgentTurnOutput` with:

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string?` | Chat message text (may be summary if suppressed) |
| `artifact` | `WorkspaceArtifact\|null` | Resolved artifact if routing to non-chat surface |
| `suppressChatContent` | `boolean` | Whether to suppress the message from chat view |
| `routingReason` | `string` | Human-readable reason for the routing decision |
| `outputChannel` | `string` | One of: chat, workspace, browser, diff, fallback |

## Audit Telemetry

`normalizeAgentOutput()` emits an `artifact_routed` audit event via `AuditLogger` for every call:
```json
{
  "event": "artifact_routed",
  "component": "ArtifactRouter",
  "turnId": "...",
  "outputChannel": "workspace",
  "routingReason": "length_threshold: message length=2500 > 2000",
  "artifactId": "...",
  "artifactType": "markdown"
}
```

## Stable Artifact IDs

`generateStableId(target, type)` uses UUID v5 with a fixed namespace to produce deterministic
IDs. The same file path or URL always yields the same artifact ID, preventing duplicate workspace
tabs for the same resource.

## Key Methods

| Method | Description |
|--------|-------------|
| `normalizeAgentOutput(message, toolResults?, turnId?)` | Main routing entry point; returns `AgentTurnOutput` with routing metadata |
| `resolveWorkspaceArtifact(res)` | Resolves a tool result into a `WorkspaceArtifact` |
| `inferArtifactTypeFromPath(filePath, context?)` | Maps file extension to `ArtifactType` |
| `generateStableId(target, type)` | Produces deterministic UUID v5 for deduplication |
