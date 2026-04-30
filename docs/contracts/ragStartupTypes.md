# Contract: ragStartupTypes.ts

**Source**: [shared\ragStartupTypes.ts](../../shared/ragStartupTypes.ts)

## Interfaces

### `RagStartupResult`
```typescript
interface RagStartupResult {
    state: ServiceStartupState;
    reason?: string;
    elapsedMs: number;
    processAlive?: boolean;
    readySignalObserved?: boolean;
}
```

### `ServiceStartupState`
```typescript
type ServiceStartupState = 
    | 'not_started'
    | 'starting'
    | 'process_ready_client_disconnected'
    | 'process_ready_tools_unlisted'
    | 'slow_start'
    | 'ready'
    | 'degraded'
    | 'failed';
```

