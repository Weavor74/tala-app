# Contract: a2uiTypes.ts

**Source**: [shared\a2uiTypes.ts](../../shared/a2uiTypes.ts)

## Interfaces

### `A2UINode`
```typescript
interface A2UINode {
    /** Unique identifier for this node within the surface. */
    id: string;
    /** Component type string (mapped to React component in catalog). */
    type: string;
    /** Props passed to the React component. */
    props?: Record<string, unknown>;
    /** Recursive children. */
    children?: A2UINode[];
}
```

### `A2UISurfacePayload`
```typescript
interface A2UISurfacePayload {
    /** Target surface ID. */
    surfaceId: A2UISurfaceId;
    /** Human-readable title for the workspace tab. */
    title: string;
    /** The A2UI component tree to render in the document/editor pane. */
    components: A2UINode[];
    /** ISO 8601 timestamp when this surface payload was assembled. */
    assembledAt: string;
    /**
     * Data source description for audit/diagnostics.
     * e.g. 'cognition:diagnostics_snapshot', 'world:world_model_assembler'
     */
    dataSource: string;
    /** Stable tab ID used to de-duplicate tabs in the workspace. */
    tabId: string;
    /**
     * Whether this surface should be focused after open.
     * Defaults to true for user-initiated opens; may be false for background refreshes.
     */
    focus?: boolean;
}
```

### `A2UISurfaceOpenRequest`
```typescript
interface A2UISurfaceOpenRequest {
    /** Surface to open. */
    surfaceId: A2UISurfaceId;
    /** Whether to focus the tab after opening. Defaults to true. */
    focus?: boolean;
}
```

### `A2UIActionDispatch`
```typescript
interface A2UIActionDispatch {
    /** Surface the action originated from. */
    surfaceId: A2UISurfaceId;
    /** The allowlisted action name. */
    actionName: A2UIActionName;
    /** Bounded action payload (validated before execution). */
    payload?: Record<string, unknown>;
}
```

### `A2UIActionResult`
```typescript
interface A2UIActionResult {
    /** Whether the action executed successfully. */
    success: boolean;
    /** Human-readable outcome message. */
    message: string;
    /** Error detail if the action failed (no sensitive data). */
    error?: string;
    /** Optional updated surface payload to push to the renderer after action. */
    updatedSurface?: A2UISurfacePayload;
}
```

### `A2UISurfaceRegistryEntry`
```typescript
interface A2UISurfaceRegistryEntry {
    /** Surface ID. */
    surfaceId: A2UISurfaceId;
    /** Stable tab ID. */
    tabId: string;
    /** ISO 8601 timestamp when the surface was last opened or updated. */
    lastUpdatedAt: string;
    /** Data source used for the most recent surface assembly. */
    dataSource: string;
}
```

### `A2UIDiagnosticsSummary`
```typescript
interface A2UIDiagnosticsSummary {
    /** Currently registered (open) surfaces. */
    openSurfaces: A2UISurfaceRegistryEntry[];
    /** Count of A2UI actions dispatched in the current session. */
    actionDispatchCount: number;
    /** Count of A2UI surface opens/updates in the current session. */
    surfaceUpdateCount: number;
    /** Count of A2UI surface failures in the current session. */
    surfaceFailureCount: number;
    /** Count of A2UI action failures in the current session. */
    actionFailureCount: number;
}
```

### `A2UISurfaceId`
```typescript
type A2UISurfaceId =  'cognition' | 'world' | 'maintenance';
```

### `A2UIActionName`
```typescript
type A2UIActionName = 
    | 'open_cognition_surface'
    | 'open_world_surface'
    | 'open_maintenance_surface'
    | 'refresh_cognition'
    | 'refresh_world'
    | 'refresh_maintenance'
    | 'run_maintenance_check'
    | 'switch_maintenance_mode'
    | 'restart_provider'
    | 'restart_mcp_service';
```

