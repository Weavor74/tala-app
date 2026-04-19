# Contract: selfModelTypes.ts

**Source**: [shared/selfModelTypes.ts](../../shared/selfModelTypes.ts)

## Interfaces

### `SelfModelInvariant`
```typescript
interface SelfModelInvariant {
    id: string;
    label: string;
    description: string;
    category: InvariantCategory;
    status: InvariantStatus;
    enforcedBy?: string;  // service/module name
    addedAt: string;      // ISO date
}
```

### `SelfModelCapability`
```typescript
interface SelfModelCapability {
    id: string;
    label: string;
    description: string;
    category: CapabilityCategory;
    status: CapabilityStatus;
    requiredFor?: string[];  // feature names that require this capability
    addedAt: string;
}
```

### `SelfModelComponent`
```typescript
interface SelfModelComponent {
    id: string;
    label: string;
    layer: ComponentLayer;
    responsibilities: string[];
    ownedBy?: string;
    path?: string;
}
```

### `OwnershipEntry`
```typescript
interface OwnershipEntry {
    componentId: string;
    subsystem: string;
    layer: ComponentLayer;
    primaryFile: string;
}
```

### `SelfModelRefreshResult`
```typescript
interface SelfModelRefreshResult {
    success: boolean;
    timestamp: string;
    invariantsLoaded: number;
    capabilitiesLoaded: number;
    componentsScanned: number;
    error?: string;
}
```

### `SelfModelSnapshot`
```typescript
interface SelfModelSnapshot {
    generatedAt: string;
    invariants: SelfModelInvariant[];
    capabilities: SelfModelCapability[];
    components: SelfModelComponent[];
    ownershipMap: OwnershipEntry[];
}
```

### `InvariantQueryResult`
```typescript
interface InvariantQueryResult {
    invariants: SelfModelInvariant[];
    total: number;
    filteredBy?: { category?: InvariantCategory; status?: InvariantStatus }
```

### `CapabilityQueryResult`
```typescript
interface CapabilityQueryResult {
    capabilities: SelfModelCapability[];
    total: number;
    filteredBy?: { category?: CapabilityCategory; status?: CapabilityStatus }
```

### `ArchitectureSummary`
```typescript
interface ArchitectureSummary {
    totalInvariants: number;
    activeInvariants: number;
    totalCapabilities: number;
    availableCapabilities: number;
    totalComponents: number;
    lastRefreshed: string | null;
}
```

### `InvariantCategory`
```typescript
type InvariantCategory =  'architectural' | 'behavioral' | 'safety' | 'ethical';
```

### `InvariantStatus`
```typescript
type InvariantStatus =  'active' | 'deprecated' | 'candidate';
```

### `CapabilityCategory`
```typescript
type CapabilityCategory =  'inference' | 'memory' | 'retrieval' | 'ui' | 'tools' | 'identity';
```

### `CapabilityStatus`
```typescript
type CapabilityStatus =  'available' | 'degraded' | 'unavailable' | 'optional';
```

### `ComponentLayer`
```typescript
type ComponentLayer =  'renderer' | 'main' | 'shared' | 'mcp' | 'data';
```

