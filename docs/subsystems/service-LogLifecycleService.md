# Service: LogLifecycleService.ts

**Source**: [electron/services/LogLifecycleService.ts](../../electron/services/LogLifecycleService.ts)

## Class: `LogLifecycleService`

### Methods

#### `getLogsDir`
**Arguments**: ``
**Returns**: `string`

---
#### `ensureLogDirectory`
**Arguments**: ``
**Returns**: `void`

---
#### `appendJsonl`
**Arguments**: `fileName: string, record: unknown`
**Returns**: `LogAppendResult`

---
#### `appendLine`
**Arguments**: `fileName: string, line: string`
**Returns**: `LogAppendResult`

---
#### `rotateOversizedOnStartup`
**Arguments**: `fileName: string`
**Returns**: `boolean`

---
#### `pruneRotated`
**Arguments**: `fileName: string`
**Returns**: `void`

---
#### `readRecentWindow`
**Arguments**: `fileName: string, options: RecentLogWindowOptions = {}`
**Returns**: `RecentLogWindow`

---
#### `readRecentWindowFromPath`
**Arguments**: `fullPath: string, options: RecentLogWindowOptions = {}`
**Returns**: `RecentLogWindow`

---
#### `resolveManagedLogPath`
**Arguments**: `fileName: string`
**Returns**: `string`

---
#### `rotateIfOversized`
**Arguments**: `activePath: string, fileName: string, maxBytes: number, reason: 'append_precheck' | 'append_postcheck' | 'startup_oversized_existing'`
**Returns**: `boolean`

---
#### `isUnderLogsRoot`
**Arguments**: `targetPath: string`
**Returns**: `boolean`

---
#### `normalizePath`
**Arguments**: `input: string`
**Returns**: `string`

---
#### `escapeRegex`
**Arguments**: `value: string`
**Returns**: `string`

---
#### `logOutsideRootIfNeeded`
**Arguments**: ``
**Returns**: `void`

---
