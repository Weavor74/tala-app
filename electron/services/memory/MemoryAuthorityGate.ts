import { TelemetryBus } from '../telemetry/TelemetryBus';
import type {
    MemoryAuthorityContext,
    MemoryAuthorityDecision,
    MemoryAuthorityReasonCode,
    MemoryWriteRequest,
    MemoryWriteCategory,
} from '../../../shared/memoryAuthorityTypes';
import type { MemoryWriteMode } from '../../../shared/turnArbitrationTypes';

const DURABLE_WRITE_CATEGORIES: ReadonlySet<MemoryWriteCategory> = new Set([
    'planning_episode',
    'execution_episode',
    'recovery_episode',
    'goal_state',
]);

const CATEGORY_ALLOWLIST_BY_WRITE_MODE: Record<MemoryWriteMode, ReadonlySet<MemoryWriteCategory>> = {
    conversation_only: new Set([
        'conversation_summary',
        'conversation_memory',
    ]),
    episodic: new Set([
        'conversation_summary',
        'conversation_memory',
        'episodic_memory',
    ]),
    goal_episode: new Set([
        'conversation_summary',
        'conversation_memory',
        'episodic_memory',
        'planning_episode',
        'execution_episode',
        'recovery_episode',
        'goal_state',
    ]),
};

class MemoryAuthorityViolationError extends Error {
    public readonly request: MemoryWriteRequest;
    public readonly context: MemoryAuthorityContext;
    public readonly decision: MemoryAuthorityDecision;
    constructor(request: MemoryWriteRequest, context: MemoryAuthorityContext, decision: MemoryAuthorityDecision) {
        super(
            `Memory authority denied for category='${request.category}' source='${request.source}'` +
            ` reasons=${decision.reasonCodes.join(',')}`,
        );
        this.name = 'MemoryAuthorityViolationError';
        this.request = request;
        this.context = context;
        this.decision = decision;
    }
}

export function detectMemoryAuthorityViolationError(
    err: unknown,
): err is Error & {
    request: MemoryWriteRequest;
    context: MemoryAuthorityContext;
    decision: MemoryAuthorityDecision;
} {
    return (
        err instanceof Error &&
        err.name === 'MemoryAuthorityViolationError' &&
        typeof (err as { decision?: unknown }).decision === 'object'
    );
}

export class MemoryAuthorityGateService {
    evaluate(
        request: MemoryWriteRequest,
        context: MemoryAuthorityContext,
    ): MemoryAuthorityDecision {
        const requiresDurableStateAuthority = DURABLE_WRITE_CATEGORIES.has(request.category);
        const requiresGoalId = requiresDurableStateAuthority;
        const requiresTurnContext = request.source !== 'system';
        const reasonCodes: MemoryAuthorityReasonCode[] = [];
        const effectiveTurnId = request.turnId ?? context.turnId;
        const effectiveGoalId = request.goalId ?? context.goalId;
        const normalizedWriteMode = context.memoryWriteMode;
        const authorityEnvelope = context.authorityEnvelope;

        this._emitEvent('memory.authority_check_requested', request, context, {
            decision: 'pending',
            reasonCodes,
            durableStateRequested: requiresDurableStateAuthority,
        });

        if (request.source === 'system') {
            if (effectiveTurnId) {
                reasonCodes.push('source_not_allowed');
            }
            if (!context.systemAuthority) {
                reasonCodes.push('system_authority_required');
            }
            if (requiresGoalId && !effectiveGoalId) {
                reasonCodes.push('goal_linkage_required');
            }
            if (reasonCodes.length === 0) {
                const allowedDecision: MemoryAuthorityDecision = {
                    requestId: request.writeId,
                    decision: 'allow',
                    category: request.category,
                    reasonCodes: [],
                    requiresGoalId,
                    requiresTurnContext: false,
                    requiresDurableStateAuthority,
                    normalizedWriteMode,
                };
                this._emitAllowed(request, context, allowedDecision, requiresDurableStateAuthority);
                return allowedDecision;
            }
            const deniedDecision: MemoryAuthorityDecision = {
                requestId: request.writeId,
                decision: 'deny',
                category: request.category,
                reasonCodes,
                requiresGoalId,
                requiresTurnContext: false,
                requiresDurableStateAuthority,
                normalizedWriteMode,
            };
            this._emitDenied(request, context, deniedDecision, requiresDurableStateAuthority);
            return deniedDecision;
        }

        if (requiresTurnContext && !effectiveTurnId) {
            reasonCodes.push('missing_turn_context');
        }
        if (!normalizedWriteMode) {
            reasonCodes.push('missing_memory_write_mode');
        }
        if (!authorityEnvelope) {
            reasonCodes.push('missing_authority_envelope');
        }
        if (requiresGoalId && !effectiveGoalId) {
            reasonCodes.push('goal_linkage_required');
        }

        if (normalizedWriteMode) {
            const allowedCategories = CATEGORY_ALLOWLIST_BY_WRITE_MODE[normalizedWriteMode];
            if (!allowedCategories.has(request.category)) {
                reasonCodes.push('invalid_category_for_write_mode');
            }
        }

        if (requiresDurableStateAuthority && authorityEnvelope) {
            if (!authorityEnvelope.canCreateDurableState) {
                reasonCodes.push('durable_state_not_permitted');
            }
            if (authorityEnvelope.authorityLevel !== 'full_authority') {
                reasonCodes.push('authority_level_insufficient');
            }
            if (context.turnMode === 'hybrid') {
                reasonCodes.push('hybrid_goal_write_not_permitted');
            } else if (context.turnMode !== 'goal_execution') {
                reasonCodes.push('goal_execution_mode_required');
            }
        }

        const decision: MemoryAuthorityDecision = {
            requestId: request.writeId,
            decision: reasonCodes.length === 0 ? 'allow' : 'deny',
            category: request.category,
            reasonCodes,
            requiresGoalId,
            requiresTurnContext,
            requiresDurableStateAuthority,
            normalizedWriteMode,
        };

        if (decision.decision === 'allow') {
            this._emitAllowed(request, context, decision, requiresDurableStateAuthority);
        } else {
            this._emitDenied(request, context, decision, requiresDurableStateAuthority);
        }

        return decision;
    }

    assertAllowed(
        request: MemoryWriteRequest,
        context: MemoryAuthorityContext,
    ): MemoryAuthorityDecision {
        const decision = this.evaluate(request, context);
        if (decision.decision === 'deny') {
            throw new MemoryAuthorityViolationError(request, context, decision);
        }
        return decision;
    }

    private _emitAllowed(
        request: MemoryWriteRequest,
        context: MemoryAuthorityContext,
        decision: MemoryAuthorityDecision,
        durableStateRequested: boolean,
    ): void {
        this._emitEvent('memory.authority_check_allowed', request, context, {
            decision: decision.decision,
            reasonCodes: decision.reasonCodes,
            durableStateRequested,
            goalIdRequired: decision.requiresGoalId,
            turnContextRequired: decision.requiresTurnContext,
        });
        this._emitEvent('memory.write_allowed', request, context, {
            decision: decision.decision,
            reasonCodes: decision.reasonCodes,
            durableStateRequested,
            goalIdRequired: decision.requiresGoalId,
            turnContextRequired: decision.requiresTurnContext,
        });
    }

    private _emitDenied(
        request: MemoryWriteRequest,
        context: MemoryAuthorityContext,
        decision: MemoryAuthorityDecision,
        durableStateRequested: boolean,
    ): void {
        this._emitEvent('memory.authority_check_denied', request, context, {
            decision: decision.decision,
            reasonCodes: decision.reasonCodes,
            durableStateRequested,
            goalIdRequired: decision.requiresGoalId,
            turnContextRequired: decision.requiresTurnContext,
        });
        this._emitEvent('memory.write_blocked', request, context, {
            decision: decision.decision,
            reasonCodes: decision.reasonCodes,
            durableStateRequested,
            goalIdRequired: decision.requiresGoalId,
            turnContextRequired: decision.requiresTurnContext,
        });
    }

    private _emitEvent(
        eventName: 'memory.authority_check_requested' | 'memory.authority_check_allowed' | 'memory.authority_check_denied' | 'memory.write_blocked' | 'memory.write_allowed',
        request: MemoryWriteRequest,
        context: MemoryAuthorityContext,
        extras: {
            decision: 'allow' | 'deny' | 'pending';
            reasonCodes: MemoryAuthorityReasonCode[];
            durableStateRequested: boolean;
            goalIdRequired?: boolean;
            turnContextRequired?: boolean;
        },
    ): void {
        const payload: Record<string, unknown> = {
            writeId: request.writeId,
            category: request.category,
            source: request.source,
            turnId: request.turnId ?? context.turnId,
            conversationId: request.conversationId ?? context.conversationId,
            goalId: request.goalId ?? context.goalId,
            turnMode: context.turnMode,
            memoryWriteMode: context.memoryWriteMode,
            authorityLevel: context.authorityEnvelope?.authorityLevel,
            decision: extras.decision,
            reasonCodes: extras.reasonCodes,
            durableStateRequested: extras.durableStateRequested,
            goalIdRequired: extras.goalIdRequired ?? false,
            turnContextRequired: extras.turnContextRequired ?? false,
        };

        TelemetryBus.getInstance().emit({
            executionId: String(payload.turnId ?? request.writeId),
            subsystem: 'memory',
            event: eventName,
            phase: 'decision',
            payload,
        });
    }
}

export const memoryAuthorityGate = new MemoryAuthorityGateService();
