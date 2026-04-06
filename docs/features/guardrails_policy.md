# Guardrails Policy Authoring — Feature Specification

## Overview

The Guardrails Policy system introduces a structured, runtime-safe configuration pipeline for defining guardrail policies in TALA. The architecture separates **policy authoring** (UI) from **policy enforcement** (runtime).

**Key separation:**
- `src/renderer/Settings.tsx` (GuardrailsTab → Policy Config sub-tab) is the **authoring surface only**
- `electron/services/policy/PolicyGate.ts` is the **runtime enforcer** — the only place enforcement decisions are made
- Validators are **evidence producers** invoked by PolicyGate, never from UI code

## Config Model

The shared config model lives at `shared/guardrails/guardrailPolicyTypes.ts`.

### GuardrailPolicyConfig

Top-level document stored at `AppSettings.guardrailPolicy`. Versioned (currently `version: 1`) for forward migration.

```typescript
interface GuardrailPolicyConfig {
    version: 1;
    activeProfileId: string;          // 'permissive' | 'balanced' | 'locked_down'
    profiles: GuardrailProfile[];
    rules: GuardrailRule[];
    validatorBindings: ValidatorBinding[];
    updatedAt: string;                // ISO-8601
}
```

### GuardrailProfile

Named policy postures. Three built-in profiles (readonly): `permissive`, `balanced`, `locked_down`. Additional custom profiles can be added.

```typescript
interface GuardrailProfile {
    id: string;
    name: string;
    description?: string;
    ruleIds: string[];        // ordered rule IDs included in this profile
    readonly?: boolean;       // built-in profiles are readonly
}
```

### GuardrailRule

A single policy rule with scope constraints and an enforcement action.

```typescript
interface GuardrailRule {
    id: string;
    name: string;
    enabled: boolean;
    scopes: GuardrailScope[];         // empty = applies globally
    severity: GuardrailSeverity;      // 'info' | 'low' | 'medium' | 'high' | 'critical'
    action: GuardrailAction;          // 'allow' | 'deny' | 'warn' | 'require_validation' | ...
    validatorBindings: ValidatorBinding[];  // used when action='require_validation'
    createdAt: string;
    updatedAt: string;
}
```

### GuardrailScope

Narrows which execution contexts a rule applies to. Multiple scopes on one rule form a logical AND.

```typescript
interface GuardrailScope {
    executionType?: ExecutionTypeScope;     // 'chat_turn' | 'autonomy_task' | ...
    executionOrigin?: ExecutionOriginScope; // 'user' | 'kernel' | 'mcp' | ...
    mode?: ModeScope;                       // 'rp' | 'hybrid' | 'assistant' | '*'
    capability?: CapabilityScope;           // 'fs_write' | 'shell_run' | ...
    memoryAction?: MemoryActionScope;       // 'memory_create' | 'memory_delete' | ...
    workflowNodeType?: WorkflowNodeTypeScope;
    autonomyAction?: AutonomyActionScope;
}
```

### ValidatorBinding

Binds a rule to a specific validator engine. Supports both local and remote providers.

```typescript
interface ValidatorBinding {
    id: string;
    name: string;
    providerKind: ValidatorProviderKind;  // see provider kinds below
    enabled: boolean;
    executionScopes: GuardrailScope[];
    supportedActions: GuardrailAction[];
    // Remote-specific
    endpointUrl?: string;
    timeoutMs?: number;
    // OPA-specific
    policyModule?: string;
    ruleName?: string;
    // GuardrailsAI-specific
    validatorName?: string;
    validatorArgs?: Record<string, unknown>;
    // Presidio-specific
    entityTypes?: string[];
    // NeMo Guardrails-specific
    railSet?: string;
    // Failure mode
    failOpen: boolean;   // true = allow on failure; false = deny on failure
    priority: number;    // lower = runs first
}
```

## Validator Provider Kinds

All seven provider kinds are defined in `VALIDATOR_PROVIDER_REGISTRY` (also in `guardrailPolicyTypes.ts`):

| Kind | Type | Description |
|---|---|---|
| `local_guardrails_ai` | Local | GuardrailsAI Python SDK via local subprocess |
| `local_presidio` | Local | Microsoft Presidio PII detection |
| `local_nemo_guardrails` | Local | NVIDIA NeMo Guardrails |
| `local_opa` | Local | Open Policy Agent (Rego policies) |
| `remote_guardrails_service` | Remote | Hosted guardrails REST service |
| `remote_nemo_guardrails` | Remote | Remote NeMo Guardrails server |
| `remote_opa` | Remote | Remote OPA server |

## Settings Integration

`GuardrailPolicyConfig` is stored at `AppSettings.guardrailPolicy` (optional field in `shared/settings.ts`).

### Persistence path:

1. User authors policy in Settings UI (`PolicyAuthoringPanel`)
2. Panel calls `api.saveSettings({ ...currentSettings, guardrailPolicy: newPolicy })`
3. Electron saves to `app_settings.json`
4. On reload, `migrateSettings()` in `src/renderer/settingsData.ts` reads it back (version-checked: only migrates if `version === 1`)
5. PolicyGate (future phase) reads `guardrailPolicy` from loaded settings at startup

### Default config:

`makeDefaultGuardrailPolicyConfig()` creates a minimal valid config with three built-in profiles (permissive / balanced / locked_down), no rules, and no validator bindings. Used in `DEFAULT_SETTINGS`.

## UI Authoring Surface

The **Policy Config** sub-tab in `GuardrailsTab` (`src/renderer/Settings.tsx`) provides:

- **Profile selector**: Switch active policy posture (permissive / balanced / locked_down / custom)
- **Rules editor**:
  - Create, edit, delete rules
  - Set severity, action, scopes (mode, executionType, origin, capability, etc.)
  - Assign rules to profiles via checkbox
  - Attach validator bindings when action = `require_validation`
- **Validator Bindings editor**:
  - Create, edit, delete bindings
  - Configure provider kind (local or remote)
  - Provider-specific fields (validatorName, endpointUrl, entityTypes, railSet, policyModule/ruleName)
  - Fail mode (failOpen / failClosed), priority, timeout

**No enforcement logic runs in the UI.** The panel is a config writer only.

## PolicyGate Consumption (Phase 2)

In a future phase, `PolicyGate.evaluate()` will load `GuardrailPolicyConfig` from settings and:

1. Resolve the active profile by `activeProfileId`
2. Find matching rules by evaluating `GuardrailScope` against the incoming `SideEffectContext`
3. Apply the rule's `action` (deny / warn / require_validation)
4. For `require_validation`, invoke the rule's `validatorBindings` via the appropriate engine

This consumption is entirely in the electron process. No evaluation crosses to the renderer.

## Constraints

- No enforcement logic in renderer/UI (maintained)
- No validator execution from the UI (maintained)
- No breaking changes to `GuardrailConfig[]` (legacy field preserved)
- No breaking changes to PolicyGate existing rules (additive only)
- Config is forward-migratable via `version` field

## Relevant Files

| File | Role |
|---|---|
| `shared/guardrails/guardrailPolicyTypes.ts` | Config model + type definitions |
| `shared/settings.ts` | `AppSettings.guardrailPolicy?: GuardrailPolicyConfig` |
| `src/renderer/settingsData.ts` | Default config, migration |
| `src/renderer/Settings.tsx` | PolicyAuthoringPanel (GuardrailsTab, Policy Config sub-tab) |
| `electron/services/policy/PolicyGate.ts` | Runtime enforcer (future consumer of this config) |
| `tests/GuardrailPolicyTypes.test.ts` | 30 tests: config schema, all provider kinds, round-trip |
| `tests/GuardrailPolicySettings.test.ts` | 20 tests: settings round-trip, migration, builder save/load |
