# Contract: modelCapabilityTypes.ts

**Source**: [shared/modelCapabilityTypes.ts](../../shared/modelCapabilityTypes.ts)

## Interfaces

### `CognitiveBudgetProfile`
```typescript
interface CognitiveBudgetProfile {
    /** Max identity memory contributions. */
    identityMemoryCap: number;
    /** Max task-relevant memory contributions. */
    taskMemoryCap: number;
    /** Max recent continuity memory contributions. */
    continuityMemoryCap: number;
    /** Max preference memory contributions. */
    preferenceMemoryCap: number;
    /** Max documentation chunks included. 0 = suppressed unless highly relevant. */
    docChunkCap: number;
    /** Max reflection behavioral notes included. */
    reflectionNoteCap: number;
    /** Max emotional modulation influence dimensions (from EmotionalModulationInput). */
    emotionalDimensionCap: number;
    /** Max tool descriptions / schemas included verbatim. */
    toolDescriptionCap: number;
    /** Whether full tool schemas are allowed (false = compact policy text only). */
    allowFullToolSchemas: boolean;
    /** Whether rich identity prose is allowed (false = compressed scaffold only). */
    allowFullIdentityProse: boolean;
    /** Whether docs are suppressed unless relevance score exceeds a threshold. */
    suppressDocsUnlessHighlyRelevant: boolean;
    /** Whether raw astro planetary data is allowed (false = compressed bias only). */
    allowRawAstroData: boolean;
}
```

### `ModelCapabilityProfile`
```typescript
interface ModelCapabilityProfile {
    /** Stable identifier for this profile entry (e.g. "ollama/qwen2.5:3b"). */
    profileId: string;
    /** Display-friendly model name. */
    modelName: string;
    /** Provider type identifier. */
    providerType: string;
    /** Estimated parameter class. */
    parameterClass: ModelParameterClass;
    /** Prompt profile class selected for this model. */
    promptProfileClass: PromptProfileClass;
    /** Cognitive budget caps for the selected profile. */
    budgetProfile: CognitiveBudgetProfile;
    /** Compaction policy for this profile. */
    compactionPolicy: CompactionPolicy;
    /** Whether the parameter class was inferred (not directly specified). */
    classInferred: boolean;
    /** Rationale for the classification (for diagnostics/explainability). */
    classificationRationale: string;
    /** Estimated context window in tokens (if known). */
    estimatedContextTokens?: number;
}
```

### `CompactPromptPacket`
```typescript
interface CompactPromptPacket {
    /** Identity core block. */
    identityCore: string;
    /** Active mode block. */
    modeBlock: string;
    /** Compressed emotional bias block. */
    emotionalBiasBlock: string;
    /** Tool policy block (concise). */
    toolPolicyBlock: string;
    /** Continuity/context block (top memory + explicit user facts). */
    continuityBlock: string;
    /** Current task/intent block. */
    currentTaskBlock: string;
    /** Response rules block. */
    responseRulesBlock: string;
    /** Assembled packet as ordered sections for final prompt injection. */
    assembledSections: string[];
    /** Diagnostics summary of what was kept and dropped. */
    diagnosticsSummary: CompactionDiagnosticsSummary;
}
```

### `CompactionDiagnosticsSummary`
```typescript
interface CompactionDiagnosticsSummary {
    /** Profile class used. */
    profileClass: PromptProfileClass;
    /** Compaction policy applied. */
    compactionPolicy: CompactionPolicy;
    /** Model parameter class. */
    parameterClass: ModelParameterClass;
    /** Total memory items kept. */
    memoriesKept: number;
    /** Total memory items dropped. */
    memoriesDropped: number;
    /** Whether docs were included. */
    docsIncluded: boolean;
    /** Number of doc chunks included. */
    docChunksIncluded: number;
    /** Number of reflection notes kept. */
    reflectionNotesKept: number;
    /** Number of reflection notes dropped. */
    reflectionNotesDropped: number;
    /** Whether emotional modulation was included. */
    emotionIncluded: boolean;
    /** Whether full identity prose or compressed scaffold was used. */
    identityMode: 'full' | 'compressed';
    /** Whether full tool schemas or compact policy were used. */
    toolMode: 'full_schemas' | 'compact_policy';
    /** Sections included in the packet (in order). */
    sectionsIncluded: string[];
    /** Sections dropped under budget pressure. */
    sectionsDropped: string[];
    /** Human-readable compaction rationale. */
    rationale: string;
}
```

### `CompressedEmotionalBias`
```typescript
interface CompressedEmotionalBias {
    /** Applied warmth bias. */
    warmth: 'low' | 'neutral' | 'high';
    /** Applied caution bias. */
    caution: 'low' | 'neutral' | 'high';
    /** Applied confidence expression. */
    confidence: 'low' | 'neutral' | 'high';
    /** Applied energy/engagement level. */
    energy: 'low' | 'neutral' | 'high';
    /** Expression shift summary (bounded prose). */
    expressionShift: string;
    /** Whether modulation was available or gracefully absent. */
    available: boolean;
}
```

### `CompressedIdentityScaffold`
```typescript
interface CompressedIdentityScaffold {
    /** Tala's role (concise). */
    role: string;
    /** Tone guidance (concise). */
    tone: string;
    /** Top priorities (concise list). */
    priorities: string[];
    /** Behavioral boundaries (concise list). */
    boundaries: string[];
    /** Continuity rule (how Tala maintains continuity across turns). */
    continuityRule: string;
    /** Whether mode-specific context was appended. */
    modeContextAppended: boolean;
}
```

### `CompactToolGuidance`
```typescript
interface CompactToolGuidance {
    /** Allowed tool categories summary (if any). */
    allowedSummary: string;
    /** Blocked tool categories summary (if any). */
    blockedSummary: string;
    /** Short use guidance (when to use tools). */
    useGuidance: string;
    /** Whether any tools are available. */
    toolsAvailable: boolean;
}
```

### `ModelParameterClass`
```typescript
type ModelParameterClass =  'tiny' | 'small' | 'medium' | 'large' | 'unknown';
```

### `PromptProfileClass`
```typescript
type PromptProfileClass =  'tiny_profile' | 'small_profile' | 'medium_profile' | 'large_profile';
```

### `CompactionPolicy`
```typescript
type CompactionPolicy =  'aggressive' | 'moderate' | 'standard' | 'full';
```

