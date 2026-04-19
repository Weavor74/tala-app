import type { KernelRequest, KernelExecutionMeta } from './AgentKernel';
import type { AgentTurnRequest } from '../../../shared/turnArbitrationTypes';

export interface KernelTurnContext {
    request: AgentTurnRequest;
    normalizedText: string;
    tokens: string[];
    hasActiveGoal: boolean;
    runtime: {
        executionId: string;
        origin: string;
        mode: string;
        modeResolution?: KernelExecutionMeta['modeResolution'];
    };
}

export class TurnContextService {
    build(request: KernelRequest, meta: KernelExecutionMeta): KernelTurnContext {
        const userText = (request.userMessage ?? '').trim();
        const normalizedText = userText.toLowerCase();
        const tokens = normalizedText.split(/[^a-z0-9_]+/g).filter(Boolean);
        return {
            request: {
                turnId: request.turnId ?? meta.executionId,
                conversationId: request.conversationId ?? 'default',
                userText,
                attachments: request.attachments,
                workspaceContext: request.workspaceContext,
                activeGoalId: request.activeGoalId,
                operatorMode: request.operatorMode ?? 'auto',
                requestedSurface: request.requestedSurface,
            },
            normalizedText,
            tokens,
            hasActiveGoal: Boolean(request.activeGoalId),
            runtime: {
                executionId: meta.executionId,
                origin: meta.origin,
                mode: meta.mode,
                modeResolution: meta.modeResolution,
            },
        };
    }
}


