import type {
    FailureClass,
    FailureScope,
    FailureSignature,
    FailureSuppressionPolicy,
    RecoveryPolicy,
    StructuredFailure,
} from '../../../../shared/runtime/failureRecoveryTypes';
import { PolicyDeniedError } from '../../policy/PolicyGate';

const DEFAULT_RECOVERY_POLICY: Record<FailureClass, RecoveryPolicy> = {
    timeout: {
        allowRetry: true,
        maxRetries: 2,
        backoffMsByAttempt: [150, 350],
        allowReroute: true,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 15_000,
        escalationTarget: 'operator',
    },
    rate_limited: {
        allowRetry: true,
        maxRetries: 2,
        backoffMsByAttempt: [500, 1_000],
        allowReroute: true,
        allowEscalation: false,
        allowReplan: true,
        degradeAllowed: true,
        cooldownMs: 30_000,
        escalationTarget: 'none',
    },
    auth_required: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: false,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 0,
        escalationTarget: 'operator',
    },
    permission_denied: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: false,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 0,
        escalationTarget: 'authority',
    },
    resource_unavailable: {
        allowRetry: true,
        maxRetries: 1,
        backoffMsByAttempt: [250],
        allowReroute: true,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: true,
        cooldownMs: 10_000,
        escalationTarget: 'operator',
    },
    dependency_unreachable: {
        allowRetry: true,
        maxRetries: 2,
        backoffMsByAttempt: [200, 500],
        allowReroute: true,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: true,
        cooldownMs: 20_000,
        escalationTarget: 'operator',
    },
    invalid_input: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: false,
        allowEscalation: false,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 0,
        escalationTarget: 'none',
    },
    policy_blocked: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: false,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 0,
        escalationTarget: 'authority',
    },
    partial_result: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: true,
        allowEscalation: false,
        allowReplan: true,
        degradeAllowed: true,
        cooldownMs: 0,
        escalationTarget: 'none',
    },
    invariant_violation: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: false,
        allowEscalation: true,
        allowReplan: false,
        degradeAllowed: false,
        cooldownMs: 0,
        escalationTarget: 'authority',
    },
    unsupported_capability: {
        allowRetry: false,
        maxRetries: 0,
        backoffMsByAttempt: [],
        allowReroute: true,
        allowEscalation: false,
        allowReplan: true,
        degradeAllowed: true,
        cooldownMs: 0,
        escalationTarget: 'none',
    },
    unknown: {
        allowRetry: true,
        maxRetries: 1,
        backoffMsByAttempt: [200],
        allowReroute: false,
        allowEscalation: true,
        allowReplan: true,
        degradeAllowed: false,
        cooldownMs: 10_000,
        escalationTarget: 'operator',
    },
};

const TOKENS = {
    timeout: ['timeout', 'timed out', 'etimedout', 'stream open timeout'],
    rateLimited: ['rate limit', 'too many requests', '429', 'quota'],
    authRequired: ['unauthorized', 'auth required', 'api key', 'token expired', '401'],
    permissionDenied: ['permission denied', 'forbidden', '403', 'not permitted', 'eacces', 'eprem'],
    resourceUnavailable: ['not found', 'missing resource', 'resource unavailable'],
    dependencyUnreachable: ['econnrefused', 'econnreset', 'eai_again', 'unreachable', 'network', 'dns'],
    invalidInput: ['invalid input', 'bad request', 'validation', 'schema', 'malformed', 'missing required'],
    invariantViolation: ['invariant', 'assertion', 'canonical authority', 'authority mismatch'],
    unsupported: ['unsupported', 'not implemented', 'not supported'],
    partial: ['partial', 'incomplete'],
};

export interface FailureNormalizationInput {
    error: unknown;
    scope: FailureScope;
    reasonCodeFallback: string;
    messageFallback: string;
    providerId?: string;
    toolId?: string;
    workflowId?: string;
    stepId?: string;
    metadata?: Record<string, unknown>;
}

export function getDefaultRecoveryPolicy(failureClass: FailureClass): RecoveryPolicy {
    return { ...DEFAULT_RECOVERY_POLICY[failureClass] };
}

function includesAny(message: string, tokens: string[]): boolean {
    return tokens.some((token) => message.includes(token));
}

function deriveReasonCode(error: unknown, fallback: string): string {
    if (error instanceof PolicyDeniedError) {
        return error.decision.code ?? 'policy_denied';
    }
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.trim().length > 0) {
            return code;
        }
    }
    return fallback;
}

function deriveMessage(error: unknown, fallback: string): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return fallback;
}

export function normalizeStructuredFailure(input: FailureNormalizationInput): StructuredFailure {
    const message = deriveMessage(input.error, input.messageFallback).toLowerCase();
    let klass: FailureClass = 'unknown';

    if (input.error instanceof PolicyDeniedError || includesAny(message, TOKENS.permissionDenied) || includesAny(message, ['policy'])) {
        klass = 'policy_blocked';
    } else if (includesAny(message, TOKENS.timeout)) {
        klass = 'timeout';
    } else if (includesAny(message, TOKENS.rateLimited)) {
        klass = 'rate_limited';
    } else if (includesAny(message, TOKENS.authRequired)) {
        klass = 'auth_required';
    } else if (includesAny(message, TOKENS.permissionDenied)) {
        klass = 'permission_denied';
    } else if (includesAny(message, TOKENS.dependencyUnreachable)) {
        klass = 'dependency_unreachable';
    } else if (includesAny(message, TOKENS.resourceUnavailable)) {
        klass = 'resource_unavailable';
    } else if (includesAny(message, TOKENS.invalidInput)) {
        klass = 'invalid_input';
    } else if (includesAny(message, TOKENS.invariantViolation)) {
        klass = 'invariant_violation';
    } else if (includesAny(message, TOKENS.unsupported)) {
        klass = 'unsupported_capability';
    } else if (includesAny(message, TOKENS.partial)) {
        klass = 'partial_result';
    }

    const policy = getDefaultRecoveryPolicy(klass);
    return {
        class: klass,
        reasonCode: deriveReasonCode(input.error, input.reasonCodeFallback),
        retryable: policy.allowRetry,
        transient: klass === 'timeout' || klass === 'rate_limited' || klass === 'dependency_unreachable' || klass === 'resource_unavailable',
        recoverable: policy.allowRetry || policy.allowReroute || policy.degradeAllowed,
        operatorActionRequired: policy.allowEscalation && (klass === 'auth_required' || klass === 'permission_denied' || klass === 'policy_blocked' || klass === 'invariant_violation'),
        scope: input.scope,
        message: deriveMessage(input.error, input.messageFallback),
        providerId: input.providerId,
        toolId: input.toolId,
        workflowId: input.workflowId,
        stepId: input.stepId,
        rawEvidence: input.error,
        metadata: input.metadata,
    };
}

export function buildFailureSignature(input: {
    targetId: string;
    failure: StructuredFailure;
    resourceKey?: string;
    stepType?: string;
}): FailureSignature {
    const key = [
        input.targetId,
        input.failure.class,
        input.failure.reasonCode,
        input.resourceKey ?? '-',
        input.stepType ?? '-',
    ].join('|');
    return {
        key,
        class: input.failure.class,
        reasonCode: input.failure.reasonCode,
    };
}

type Clock = () => number;

interface SuppressionState {
    timestamps: number[];
    suppressedUntilMs: number;
}

export class FailureSuppressionService {
    private readonly state = new Map<string, SuppressionState>();

    constructor(
        private readonly policy: FailureSuppressionPolicy = {
            threshold: 3,
            windowMs: 30_000,
            cooldownMs: 30_000,
        },
        private readonly now: Clock = () => Date.now(),
    ) {}

    record(signature: FailureSignature): { countInWindow: number; suppressed: boolean; suppressedUntilMs?: number } {
        const nowMs = this.now();
        const current = this.state.get(signature.key) ?? { timestamps: [], suppressedUntilMs: 0 };
        const windowStart = nowMs - this.policy.windowMs;
        current.timestamps = current.timestamps.filter((ts) => ts >= windowStart);
        current.timestamps.push(nowMs);

        if (current.timestamps.length >= this.policy.threshold) {
            current.suppressedUntilMs = nowMs + this.policy.cooldownMs;
        }

        this.state.set(signature.key, current);
        const suppressed = current.suppressedUntilMs > nowMs;
        return {
            countInWindow: current.timestamps.length,
            suppressed,
            suppressedUntilMs: suppressed ? current.suppressedUntilMs : undefined,
        };
    }

    isSuppressed(signature: FailureSignature): { suppressed: boolean; suppressedUntilMs?: number } {
        const nowMs = this.now();
        const current = this.state.get(signature.key);
        if (!current || current.suppressedUntilMs <= nowMs) {
            return { suppressed: false };
        }
        return {
            suppressed: true,
            suppressedUntilMs: current.suppressedUntilMs,
        };
    }
}

export function selectEquivalentTarget(
    currentTargetId: string,
    declaredEquivalents: readonly string[] | undefined,
): string[] {
    if (!declaredEquivalents || declaredEquivalents.length === 0) return [];
    const deduped: string[] = [];
    const seen = new Set<string>([currentTargetId]);
    for (const candidate of declaredEquivalents) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        deduped.push(candidate);
    }
    return deduped;
}

