# Service: PromptAuditService.ts

**Source**: [electron\services\PromptAuditService.ts](../../electron/services/PromptAuditService.ts)

## Class: `PromptAuditService`

## Overview
LLM Governance & Transparency Engine.  The `PromptAuditService` provides detailed visibility into the final prompts  sent to AI models. It captures the assembly process, inclusion flags,  and raw payloads, ensuring that engineering decisions (e.g., context pruning)  are auditable and transparent.  **Core Responsibilities:** - **Pre-flight Auditing**: Captures the exact prompt bytes before they leave     the application. - **Governance Logs**: Maintains a JSONL record of prompt metadata,    including `sessionId`, `turnId`, and `intent`. - **Redaction**: Scrubs API keys and sensitive tokens before logging. - **Volume Analysis**: Tracks character counts per context block (Astro,    Memory, History) to optimize prompt performance.

### Methods

#### `updateConfig`
**Arguments**: `config: Partial<PromptAuditConfig>`

---
#### `initLogPath`
**Arguments**: ``

---
#### `trunc`
**Arguments**: `text: string | undefined | null, maxLen: number`
**Returns**: `string`

---
#### `emit`
Records a complete prompt audit event.  This is the primary entry point for capturing the final state of an  LLM request. Depending on the `level` configuration, it will output  to the console, to a persistent JSONL file, or both.  @param record - The fully assembled `PromptAuditRecord`./

**Arguments**: `record: PromptAuditRecord`
**Returns**: `void`

---
#### `consoleLog`
**Arguments**: `r: PromptAuditRecord`
**Returns**: `void`

---
#### `fileLog`
**Arguments**: `r: PromptAuditRecord`
**Returns**: `void`

---
