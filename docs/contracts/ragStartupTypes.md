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
    | 'slow_start'
    | 'ready'
    | 'degraded'
    | 'failed';
```

