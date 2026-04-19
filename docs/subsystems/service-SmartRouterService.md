# Service: SmartRouterService.ts

**Source**: [electron/services/SmartRouterService.ts](../../electron/services/SmartRouterService.ts)

## Class: `SmartRouterService`

## Overview
SmartRouterService
 
 Implements "Economic Intelligence" by selecting the most cost-effective
 model for a given task.

### Methods

#### `setMode`
**Arguments**: `mode: 'auto' | 'local-only' | 'cloud-only'`

---
#### `route`
Routes a specific task to the optimal brain.
/

**Arguments**: `messages: ChatMessage[], systemPrompt: string`
**Returns**: `Promise<IBrain>`

---
#### `isComplexTask`
**Arguments**: `prompt: string, system: string`
**Returns**: `boolean`

---
