# Service: IpcRouter.ts

**Source**: [electron/services/IpcRouter.ts](../../electron/services/IpcRouter.ts)

## Class: `IpcRouter`

## Overview
Central API Registry for the Electron shell.
 
 The `IpcRouter` orchestrates all communication between the React renderer and the 
 backend services. It manages:
 - Application lifecycle and settings migration.
 - AI agent orchestration and streaming chat responses.
 - File system operations and workspace sandboxing.
 - Integration with peripheral services (Git, MCP, Guardrails, Backup).
 - System-level interactions (Terminal PTYs, OAuth, Native Dialogs).

### Methods

