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
    /** Whether this is a built-in profile (built-ins cannot be deleted). */
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

// ─── Default config factory ───────────────────────────────────────────────────

/**
 * Creates a minimal valid GuardrailPolicyConfig with three built-in profiles
 * and no rules. Use this to initialise a new config in DEFAULT_SETTINGS.
 */
export function buildDefaultGuardrailPolicyConfig(): GuardrailPolicyConfig {
    const now = new Date().toISOString();
    return {
        version: 1,
        activeProfileId: 'balanced',
        profiles: [
            {
                id: 'permissive',
                name: 'Permissive',
                description: 'Minimal restrictions — allows most actions. Suitable for trusted development environments.',
                ruleIds: [],
                readonly: true,
            },
            {
                id: 'balanced',
                name: 'Balanced',
                description: 'Moderate guardrails — blocks high-risk actions, warns on medium-risk actions.',
                ruleIds: [],
                readonly: true,
            },
            {
                id: 'locked_down',
                name: 'Locked Down',
                description: 'Strict restrictions — requires validation for most side-effectful actions.',
                ruleIds: [],
                readonly: true,
            },
        ],
        rules: [],
        validatorBindings: [],
        updatedAt: now,
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

