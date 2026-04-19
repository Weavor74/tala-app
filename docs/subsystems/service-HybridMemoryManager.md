# Service: HybridMemoryManager.ts

**Source**: [electron/services/HybridMemoryManager.ts](../../electron/services/HybridMemoryManager.ts)

## Class: `HybridMemoryManager`

## Overview
HybridMemoryManager
 
 Orchestrates tiered retrieval from Graph, Mem0, and RAG.
 Implements the "Tiered Recovery" pattern:
 1. Graph (Structural/Relational) - High precision, context-aware.
 2. Mem0 (Fuzzy Facts) - Conversational drift and user preferences.
 3. RAG (Grounding) - Broad document-based knowledge.

### Methods

#### `getIntegratedContext`
Retrieves an integrated context string from all memory layers.
/

**Arguments**: `query: string, options: HybridContextOptions = {}, mode: string = 'assistant'`
**Returns**: `Promise<string>`

---
#### `getGraphContext`
**Arguments**: `query: string, maxNodes: number, maxEdges: number, emotion: string, intensity: number, identity?: UserIdentityContext, mode: string = 'assistant'`
**Returns**: `Promise<string>`

---
