/**
 * guardrailPolicyTypes.ts
 *
 * Shared config model for the Guardrails Policy authoring pipeline.
 *
 * Architecture intent:
 *   - The GuardrailsTab in Settings.tsx is an **authoring surface only**.
 *     It produces structured configuration that gets persisted to AppSettings.
 *   - PolicyGate is the **runtime enforcer**. It consumes this config to make
 *     allow/deny decisions. No enforcement logic ever lives in the renderer.
 *   - Validators are **evidence producers**. They are invoked by PolicyGate and
 *     related guardrail services, never from UI code.
 *
 * Usage:
 *   - GuardrailPolicyConfig is stored at AppSettings.guardrailPolicy.
 *   - PolicyGate can consume it in a future phase without UI involvement.
 *   - Config is round-trip serialisable (plain-object JSON).
 *
 * Node.js + Renderer — this file is shared. It must not import from 'electron'
 * or any Node-only module.
 */

// ─── Validator provider kinds ─────────────────────────────────────────────────

/**
 * Identifies the runtime engine that will execute a validator.
 *
 * Local providers run in-process or via a local subprocess.
 * Remote providers communicate over HTTP/gRPC to an external service.
 */
export type ValidatorProviderKind =
    | 'local_guardrails_ai'      // GuardrailsAI Python SDK running locally
    | 'local_presidio'           // Microsoft Presidio (PII detection) running locally
    | 'local_nemo_guardrails'    // NVIDIA NeMo Guardrails running locally
    | 'local_opa'                // Open Policy Agent running locally
    | 'remote_guardrails_service' // Hosted guardrails REST service
    | 'remote_nemo_guardrails'   // Remote NeMo Guardrails server
    | 'remote_opa';              // Remote OPA server (Policy as Code)

// ─── Scopes ───────────────────────────────────────────────────────────────────

/**
 * Scopes narrow which execution contexts a rule applies to.
 *
 * Multiple scopes on the same rule form a logical AND (all must match).
 * A rule with no scopes array (or empty scopes) applies to all contexts.
 */

/** Execution type scope — matches on the logical kind of execution. */
export type ExecutionTypeScope =
    | 'chat_turn'
    | 'autonomy_task'
    | 'workflow_node'
    | 'tool_invocation'
    | 'memory_operation'
    | 'mcp_call'
    | 'system';

/** Execution origin scope — matches on which subsystem initiated the execution. */
export type ExecutionOriginScope =
    | 'user'
    | 'kernel'
    | 'autonomy_engine'
    | 'mcp'
    | 'ipc'
    | 'scheduler'
    | 'system';

/** Mode scope — matches on the active agent interaction mode. */
export type ModeScope = 'rp' | 'hybrid' | 'assistant' | 'system' | '*';

/** Tool capability or subsystem scope. */
export type CapabilityScope =
    | 'fs_read'
    | 'fs_write'
    | 'shell_run'
    | 'mem0_add'
    | 'mem0_search'
    | 'workflow_run'
    | 'mcp_tool'
    | 'web_browse'
    | 'code_exec'
    | string;             // extensible for future tools

/** Memory action scope. */
export type MemoryActionScope =
    | 'memory_create'
    | 'memory_update'
    | 'memory_delete'
    | 'memory_tombstone'
    | 'memory_search';

/** Workflow node type scope. */
export type WorkflowNodeTypeScope =
    | 'workflow_tool'
    | 'workflow_llm'
    | 'workflow_condition'
    | 'workflow_loop'
    | 'workflow_guardrail';

/** Autonomy action scope. */
export type AutonomyActionScope =
    | 'goal_start'
    | 'goal_step'
    | 'goal_complete'
    | 'goal_abort';

/**
 * A single scope constraint attached to a rule.
 * Exactly one of the optional kind fields should be populated.
 */
export interface GuardrailScope {
    /** If set, rule applies only when executionType matches. */
    executionType?: ExecutionTypeScope;
    /** If set, rule applies only when executionOrigin matches. */
    executionOrigin?: ExecutionOriginScope;
    /** If set, rule applies only in the specified mode. */
    mode?: ModeScope;
    /** If set, rule applies only for this capability or subsystem. */
    capability?: CapabilityScope;
    /** If set, rule applies only for this memory action. */
    memoryAction?: MemoryActionScope;
    /** If set, rule applies only for this workflow node type. */
    workflowNodeType?: WorkflowNodeTypeScope;
    /** If set, rule applies only for this autonomy action. */
    autonomyAction?: AutonomyActionScope;
}

// ─── Severity ─────────────────────────────────────────────────────────────────

/**
 * Severity level of a rule violation.
 *
 * Used for audit logging, telemetry, and future UI display.
 * Does not determine enforcement — that is set by GuardrailAction.
 */
export type GuardrailSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * The enforcement action taken by PolicyGate when a rule matches.
 *
 * allow              — Permit the action (default passthrough).
 * deny               — Block the action; throw PolicyDeniedError.
 * warn               — Log the violation and allow; surface to audit log.
 * require_validation — Block until bound validators pass. PolicyGate
 *                      invokes validators before deciding.
 * require_confirmation — Future-ready: request explicit user confirmation
 *                        before proceeding. Currently treated as warn.
 */
export type GuardrailAction =
    | 'allow'
    | 'deny'
    | 'warn'
    | 'require_validation'
    | 'require_confirmation';

// ─── Validator bindings ───────────────────────────────────────────────────────

/**
 * A binding from a rule to a specific validator instance.
 *
 * The binding tells PolicyGate how to invoke the validator when the rule
 * triggers. Remote bindings require endpointUrl; local bindings may use
 * provider-specific configuration fields.
 *
 * Only the fields relevant to the chosen providerKind need to be populated.
 */
export interface ValidatorBinding {
    /** Unique stable ID for this binding within the config. */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** The engine that will execute this validator. */
    providerKind: ValidatorProviderKind;
    /** Whether this binding is active. Inactive bindings are skipped at runtime. */
    enabled: boolean;

    // ── Scope / applicability ────────────────────────────────────────────────
    /** Execution scopes for which this validator runs. Empty = all scopes. */
    executionScopes: GuardrailScope[];
    /** GuardrailActions this validator supports producing evidence for. */
    supportedActions: GuardrailAction[];

    // ── Remote connection (for remote_* providers) ───────────────────────────
    /** HTTP(S) or gRPC endpoint URL for remote providers. */
    endpointUrl?: string;
    /** Request timeout in milliseconds (default: 5000). */
    timeoutMs?: number;

    // ── OPA-specific (local_opa / remote_opa) ────────────────────────────────
    /** OPA policy module path (e.g. "policy/guardrails"). */
    policyModule?: string;
    /** OPA rule name to evaluate (e.g. "allow", "deny"). */
    ruleName?: string;

    // ── GuardrailsAI-specific (local_guardrails_ai) ──────────────────────────
    /** GuardrailsAI validator class name (e.g. "ToxicLanguage"). */
    validatorName?: string;
    /** Extra arguments passed to the GuardrailsAI validator constructor. */
    validatorArgs?: Record<string, unknown>;

    // ── Presidio-specific (local_presidio) ───────────────────────────────────
    /** Entity types to scan for (e.g. ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER"]). */
    entityTypes?: string[];

    // ── NeMo Guardrails-specific (local_nemo_guardrails / remote_nemo_guardrails) ──
    /** NeMo Guardrails rail set / config name. */
    railSet?: string;

    // ── Failure mode ─────────────────────────────────────────────────────────
    /**
     * How to behave when the validator is unreachable or throws.
     *
     * failOpen  — allow the action on validator failure (permissive).
     * failClosed — deny the action on validator failure (safe default).
     */
    failOpen: boolean;

    /**
     * Priority order for binding execution within a rule.
     * Lower number = runs first. Ties resolved by insertion order.
     */
    priority: number;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * A single policy rule authored in the GuardrailsTab.
 *
 * Rules are scoped to specific execution contexts via the `scopes` array.
 * When a rule matches, its `action` is returned to PolicyGate.
 * If action is `require_validation`, bound validators are invoked first.
 */
export interface GuardrailRule {
    /** Unique stable ID for this rule within the config. */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** Optional description of what this rule guards. */
    description?: string;
    /** Whether this rule is active. Disabled rules are skipped at runtime. */
    enabled: boolean;
    /**
     * Scope constraints. All must match for the rule to fire.
     * Empty array means the rule applies to all contexts (global rule).
     */
    scopes: GuardrailScope[];
    /** Severity label for audit and telemetry. Does not affect enforcement. */
    severity: GuardrailSeverity;
    /** Enforcement action when this rule matches. */
    action: GuardrailAction;
    /** Validator bindings invoked when action === 'require_validation'. */
    validatorBindings: ValidatorBinding[];
    /** ISO-8601 timestamp when this rule was created. */
    createdAt: string;
    /** ISO-8601 timestamp of last modification. */
    updatedAt: string;
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

/**
 * A named policy profile grouping a set of rules.
 *
 * Profiles allow users to switch between pre-configured postures without
 * individually toggling rules. PolicyGate activates the profile specified
 * in GuardrailPolicyConfig.activeProfileId.
 *
 * Suggested built-in profile IDs: 'permissive', 'balanced', 'locked_down'.
 */
export interface GuardrailProfile {
    /** Unique stable ID (e.g. 'permissive', 'balanced', 'locked_down'). */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** Optional description of the posture this profile represents. */
    description?: string;
    /** Ordered list of rule IDs included in this profile. */
    ruleIds: string[];
    /** Whether this is a built-in profile (built-ins cannot be deleted or renamed). */
    isBuiltIn: boolean;
    /**
     * Legacy compatibility field.
     * @deprecated Use isBuiltIn instead.
     */
    readonly?: boolean;
}

// ─── Top-level config ─────────────────────────────────────────────────────────

/**
 * GuardrailPolicyConfig — the top-level structured guardrail policy document.
 *
 * This is the authoritative config artifact produced by the GuardrailsTab.
 * It is stored at AppSettings.guardrailPolicy and consumed by PolicyGate
 * during runtime enforcement.
 *
 * The UI writes this config. PolicyGate reads it. No enforcement runs in
 * the renderer.
 */
export interface GuardrailPolicyConfig {
    /** Schema version for forward migration. Current version: 1. */
    version: 1;
    /** ID of the active profile. Must match a profile in `profiles`. */
    activeProfileId: string;
    /** All policy profiles available in this config. */
    profiles: GuardrailProfile[];
    /** All rules defined across all profiles. Profiles reference rules by ID. */
    rules: GuardrailRule[];
    /** All validator bindings defined across all rules. Rules reference them by ID. */
    validatorBindings: ValidatorBinding[];
    /** ISO-8601 timestamp of last config save. */
    updatedAt: string;
}

export const BUILTIN_GUARDRAIL_PROFILE_IDS = {
    unrestricted: 'unrestricted',
    casual: 'casual',
    businessOnly: 'business_only',
} as const;

const LEGACY_PROFILE_ID_MAP: Record<string, string> = {
    permissive: BUILTIN_GUARDRAIL_PROFILE_IDS.unrestricted,
    balanced: BUILTIN_GUARDRAIL_PROFILE_IDS.casual,
    locked_down: BUILTIN_GUARDRAIL_PROFILE_IDS.businessOnly,
};

const BUILTIN_RULE_IDS = {
    basicSafetyWarn: 'builtin-basic-safety-warn',
    localToolValidation: 'builtin-local-tool-validation',
    denyShellRun: 'builtin-deny-shell-run',
    denyFsWrite: 'builtin-deny-fs-write',
} as const;

function _cloneBinding(binding: ValidatorBinding): ValidatorBinding {
    return {
        ...binding,
        executionScopes: [...(binding.executionScopes ?? [])],
        supportedActions: [...(binding.supportedActions ?? [])],
        validatorArgs: binding.validatorArgs ? { ...binding.validatorArgs } : undefined,
        entityTypes: binding.entityTypes ? [...binding.entityTypes] : undefined,
    };
}

function _cloneRule(rule: GuardrailRule): GuardrailRule {
    return {
        ...rule,
        scopes: [...(rule.scopes ?? [])],
        validatorBindings: [...(rule.validatorBindings ?? [])].map(_cloneBinding),
    };
}

function _cloneProfile(profile: GuardrailProfile): GuardrailProfile {
    return {
        ...profile,
        ruleIds: [...(profile.ruleIds ?? [])],
        isBuiltIn: profile.isBuiltIn ?? Boolean(profile.readonly),
    };
}

function _sanitizeProfileName(name: string, fallback: string): string {
    const next = (name ?? '').trim();
    return next.length > 0 ? next : fallback;
}

function _makeCustomProfileId(existing: GuardrailProfile[]): string {
    const existingIds = new Set(existing.map(p => p.id));
    let attempts = 0;
    while (attempts < 10000) {
        attempts += 1;
        const candidate = `custom-${Date.now()}-${attempts}`;
        if (!existingIds.has(candidate)) {
            return candidate;
        }
    }
    return `custom-${Math.floor(Math.random() * 1_000_000_000)}`;
}

function _upsertBuiltInRule(
    existingRule: GuardrailRule | undefined,
    incomingRule: GuardrailRule,
): GuardrailRule {
    if (!existingRule) return _cloneRule(incomingRule);
    return {
        ..._cloneRule(existingRule),
        name: incomingRule.name,
        description: incomingRule.description,
        severity: incomingRule.severity,
        action: incomingRule.action,
        scopes: [...incomingRule.scopes],
    };
}

function _buildBuiltInRules(now: string): GuardrailRule[] {
    return [
        {
            id: BUILTIN_RULE_IDS.basicSafetyWarn,
            name: 'Basic Safety Warnings',
            description: 'Warn on baseline safety-sensitive content paths.',
            enabled: true,
            scopes: [],
            severity: 'medium',
            action: 'warn',
            validatorBindings: [],
            createdAt: now,
            updatedAt: now,
        },
        {
            id: BUILTIN_RULE_IDS.localToolValidation,
            name: 'Local Tool Validation',
            description: 'Require validation checks before high-impact tool execution.',
            enabled: true,
            scopes: [{ executionType: 'tool_invocation' }],
            severity: 'high',
            action: 'require_validation',
            validatorBindings: [],
            createdAt: now,
            updatedAt: now,
        },
        {
            id: BUILTIN_RULE_IDS.denyShellRun,
            name: 'Deny Shell Execution',
            description: 'Block direct shell execution for business-only posture.',
            enabled: true,
            scopes: [{ capability: 'shell_run' }],
            severity: 'critical',
            action: 'deny',
            validatorBindings: [],
            createdAt: now,
            updatedAt: now,
        },
        {
            id: BUILTIN_RULE_IDS.denyFsWrite,
            name: 'Deny Filesystem Writes',
            description: 'Block direct filesystem writes for business-only posture.',
            enabled: true,
            scopes: [{ capability: 'fs_write' }],
            severity: 'critical',
            action: 'deny',
            validatorBindings: [],
            createdAt: now,
            updatedAt: now,
        },
    ];
}

function _buildBuiltInProfiles(): GuardrailProfile[] {
    return [
        {
            id: BUILTIN_GUARDRAIL_PROFILE_IDS.unrestricted,
            name: 'Unrestricted',
            description: 'No policy rules applied.',
            ruleIds: [],
            isBuiltIn: true,
        },
        {
            id: BUILTIN_GUARDRAIL_PROFILE_IDS.casual,
            name: 'Casual',
            description: 'Basic safety warnings with tool validation checks.',
            ruleIds: [
                BUILTIN_RULE_IDS.basicSafetyWarn,
                BUILTIN_RULE_IDS.localToolValidation,
            ],
            isBuiltIn: true,
        },
        {
            id: BUILTIN_GUARDRAIL_PROFILE_IDS.businessOnly,
            name: 'Business Only',
            description: 'Strict safety posture with capability restrictions.',
            ruleIds: [
                BUILTIN_RULE_IDS.basicSafetyWarn,
                BUILTIN_RULE_IDS.localToolValidation,
                BUILTIN_RULE_IDS.denyShellRun,
                BUILTIN_RULE_IDS.denyFsWrite,
            ],
            isBuiltIn: true,
        },
    ];
}

// ─── Default config factory ───────────────────────────────────────────────────

/**
 * Creates a minimal valid GuardrailPolicyConfig with three built-in profiles
 * and no rules. Use this to initialise a new config in DEFAULT_SETTINGS.
 */
export function buildDefaultGuardrailPolicyConfig(): GuardrailPolicyConfig {
    const now = new Date().toISOString();
    const rules = _buildBuiltInRules(now);
    const profiles = _buildBuiltInProfiles();
    return {
        version: 1,
        activeProfileId: BUILTIN_GUARDRAIL_PROFILE_IDS.casual,
        profiles,
        rules,
        validatorBindings: [],
        updatedAt: now,
    };
}

export function normalizeGuardrailPolicyConfig(
    config: GuardrailPolicyConfig | undefined,
): GuardrailPolicyConfig {
    if (!config) {
        return buildDefaultGuardrailPolicyConfig();
    }

    const now = new Date().toISOString();
    const next: GuardrailPolicyConfig = {
        ...config,
        version: 1,
        activeProfileId: config.activeProfileId,
        profiles: (config.profiles ?? []).map(_cloneProfile),
        rules: (config.rules ?? []).map(_cloneRule),
        validatorBindings: (config.validatorBindings ?? []).map(_cloneBinding),
        updatedAt: config.updatedAt ?? now,
    };

    for (const p of next.profiles) {
        if (LEGACY_PROFILE_ID_MAP[p.id]) {
            p.id = LEGACY_PROFILE_ID_MAP[p.id];
        }
    }
    if (LEGACY_PROFILE_ID_MAP[next.activeProfileId]) {
        next.activeProfileId = LEGACY_PROFILE_ID_MAP[next.activeProfileId];
    }

    const builtInRules = _buildBuiltInRules(now);
    for (const builtInRule of builtInRules) {
        const idx = next.rules.findIndex(r => r.id === builtInRule.id);
        if (idx < 0) {
            next.rules.push(_cloneRule(builtInRule));
        } else {
            next.rules[idx] = _upsertBuiltInRule(next.rules[idx], builtInRule);
        }
    }

    const builtInProfiles = _buildBuiltInProfiles();
    for (const builtIn of builtInProfiles) {
        const idx = next.profiles.findIndex(p => p.id === builtIn.id);
        if (idx < 0) {
            next.profiles.push(_cloneProfile(builtIn));
        } else {
            next.profiles[idx] = {
                ...next.profiles[idx],
                id: builtIn.id,
                name: builtIn.name,
                description: builtIn.description,
                ruleIds: [...builtIn.ruleIds],
                isBuiltIn: true,
            };
        }
    }

    const knownRuleIds = new Set(next.rules.map(r => r.id));
    next.profiles = next.profiles
        .map(profile => ({
            ...profile,
            ruleIds: profile.ruleIds.filter(ruleId => knownRuleIds.has(ruleId)),
        }))
        .filter((profile, idx, arr) => arr.findIndex(p => p.id === profile.id) === idx);

    if (!next.profiles.some(p => p.id === next.activeProfileId)) {
        next.activeProfileId = BUILTIN_GUARDRAIL_PROFILE_IDS.casual;
    }

    return next;
}

export function createBlankGuardrailProfile(
    config: GuardrailPolicyConfig,
    name: string = 'Custom Profile',
): GuardrailPolicyConfig {
    const profileId = _makeCustomProfileId(config.profiles);
    const nextProfile: GuardrailProfile = {
        id: profileId,
        name: _sanitizeProfileName(name, 'Custom Profile'),
        ruleIds: [],
        isBuiltIn: false,
    };
    return {
        ...config,
        profiles: [...config.profiles.map(_cloneProfile), nextProfile],
        activeProfileId: profileId,
        updatedAt: new Date().toISOString(),
    };
}

export function cloneGuardrailProfile(
    config: GuardrailPolicyConfig,
    sourceProfileId: string,
    name?: string,
): GuardrailPolicyConfig {
    const source = config.profiles.find(p => p.id === sourceProfileId);
    if (!source) {
        throw new Error(`Profile '${sourceProfileId}' not found`);
    }
    const profileId = _makeCustomProfileId(config.profiles);
    const nextProfile: GuardrailProfile = {
        id: profileId,
        name: _sanitizeProfileName(name ?? `${source.name} Copy`, `${source.name} Copy`),
        ruleIds: [...source.ruleIds],
        isBuiltIn: false,
    };
    return {
        ...config,
        profiles: [...config.profiles.map(_cloneProfile), nextProfile],
        activeProfileId: profileId,
        updatedAt: new Date().toISOString(),
    };
}

export function renameGuardrailProfile(
    config: GuardrailPolicyConfig,
    profileId: string,
    nextName: string,
): GuardrailPolicyConfig {
    const profile = config.profiles.find(p => p.id === profileId);
    if (!profile) {
        throw new Error(`Profile '${profileId}' not found`);
    }
    if (profile.isBuiltIn || profile.readonly) {
        throw new Error(`Built-in profile '${profile.name}' cannot be renamed`);
    }
    const trimmedName = _sanitizeProfileName(nextName, profile.name);
    return {
        ...config,
        profiles: config.profiles.map(p => (p.id === profileId ? { ...p, name: trimmedName } : _cloneProfile(p))),
        updatedAt: new Date().toISOString(),
    };
}

export function deleteGuardrailProfile(
    config: GuardrailPolicyConfig,
    profileId: string,
): GuardrailPolicyConfig {
    const profile = config.profiles.find(p => p.id === profileId);
    if (!profile) {
        throw new Error(`Profile '${profileId}' not found`);
    }
    if (profile.isBuiltIn || profile.readonly) {
        throw new Error(`Built-in profile '${profile.name}' cannot be deleted`);
    }
    const remaining = config.profiles.filter(p => p.id !== profileId).map(_cloneProfile);
    const fallbackActive = remaining.find(p => p.id === config.activeProfileId)?.id
        ?? remaining[0]?.id
        ?? BUILTIN_GUARDRAIL_PROFILE_IDS.casual;
    return {
        ...config,
        profiles: remaining,
        activeProfileId: fallbackActive,
        updatedAt: new Date().toISOString(),
    };
}

export function setActiveGuardrailProfile(
    config: GuardrailPolicyConfig,
    profileId: string,
): GuardrailPolicyConfig {
    if (!config.profiles.some(p => p.id === profileId)) {
        throw new Error(`Profile '${profileId}' not found`);
    }
    return {
        ...config,
        activeProfileId: profileId,
        updatedAt: new Date().toISOString(),
    };
}

// ─── Helper types ─────────────────────────────────────────────────────────────

/**
 * Metadata about a ValidatorProviderKind for UI display.
 */
export interface ValidatorProviderMeta {
    kind: ValidatorProviderKind;
    label: string;
    description: string;
    isRemote: boolean;
    /** Provider-specific fields the user must configure. */
    requiredFields: Array<keyof ValidatorBinding>;
    /** Provider-specific fields optionally configurable. */
    optionalFields: Array<keyof ValidatorBinding>;
}

/** Registry of provider metadata for the builder UI. */
export const VALIDATOR_PROVIDER_REGISTRY: ValidatorProviderMeta[] = [
    {
        kind: 'local_guardrails_ai',
        label: 'GuardrailsAI (Local)',
        description: 'Runs GuardrailsAI validators locally via Python subprocess. Requires guardrails-ai installed.',
        isRemote: false,
        requiredFields: ['validatorName'],
        optionalFields: ['validatorArgs', 'failOpen', 'priority'],
    },
    {
        kind: 'local_presidio',
        label: 'Presidio (Local)',
        description: 'Microsoft Presidio PII detection running locally. Requires presidio-analyzer installed.',
        isRemote: false,
        requiredFields: ['entityTypes'],
        optionalFields: ['failOpen', 'priority'],
    },
    {
        kind: 'local_nemo_guardrails',
        label: 'NeMo Guardrails (Local)',
        description: 'NVIDIA NeMo Guardrails running locally. Requires nemoguardrails installed.',
        isRemote: false,
        requiredFields: ['railSet'],
        optionalFields: ['failOpen', 'priority'],
    },
    {
        kind: 'local_opa',
        label: 'OPA (Local)',
        description: 'Open Policy Agent running locally. Policy decisions via Rego policies.',
        isRemote: false,
        requiredFields: ['policyModule', 'ruleName'],
        optionalFields: ['endpointUrl', 'timeoutMs', 'failOpen', 'priority'],
    },
    {
        kind: 'remote_guardrails_service',
        label: 'Guardrails Service (Remote)',
        description: 'Hosted guardrails REST service. Sends content to a remote endpoint for validation.',
        isRemote: true,
        requiredFields: ['endpointUrl'],
        optionalFields: ['timeoutMs', 'failOpen', 'priority'],
    },
    {
        kind: 'remote_nemo_guardrails',
        label: 'NeMo Guardrails (Remote)',
        description: 'Remote NeMo Guardrails server. Communicates via HTTP API.',
        isRemote: true,
        requiredFields: ['endpointUrl', 'railSet'],
        optionalFields: ['timeoutMs', 'failOpen', 'priority'],
    },
    {
        kind: 'remote_opa',
        label: 'OPA (Remote)',
        description: 'Remote Open Policy Agent server. Policy decisions via Rego policies over HTTP.',
        isRemote: true,
        requiredFields: ['endpointUrl', 'policyModule', 'ruleName'],
        optionalFields: ['timeoutMs', 'failOpen', 'priority'],
    },
];

