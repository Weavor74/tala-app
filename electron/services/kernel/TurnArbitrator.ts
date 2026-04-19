import type {
    TurnArbitrationDecision,
    TurnAuthorityEnvelope,
    TurnIntentStrength,
} from '../../../shared/turnArbitrationTypes';
import type { KernelTurnContext } from './TurnContextBuilder';
import type { TurnIntentProfile } from '../../../shared/turnArbitrationTypes';

export class TurnArbitrationService {
    arbitrate(
        context: KernelTurnContext,
        profile: TurnIntentProfile,
    ): { decision: TurnArbitrationDecision; envelope: TurnAuthorityEnvelope } {
        const operatorMode = context.request.operatorMode ?? 'auto';
        const reasonCodes = [...profile.reasonCodes];

        let mode: TurnArbitrationDecision['mode'] = 'conversational';
        let source: TurnArbitrationDecision['source'] = 'rule_based';
        let confidence = 0.7;

        if (operatorMode === 'goal') {
            mode = 'goal_execution';
            source = 'operator_override';
            confidence = 1;
            reasonCodes.push('arbitration:operator_override_goal');
        } else if (operatorMode === 'chat') {
            mode = 'conversational';
            source = 'operator_override';
            confidence = 1;
            reasonCodes.push('arbitration:operator_override_chat');
            if (profile.goalExecutionWeight >= 0.5) {
                reasonCodes.push('arbitration:operator_goal_promotion_rejected');
            }
            if (profile.selfInspectionDetected) {
                mode = 'hybrid';
                source = 'rule_based';
                confidence = 0.97;
                reasonCodes.push('arbitration:self_inspection_forced_substantive');
                reasonCodes.push('arbitration:self_inspection_bypassed_chat_override');
            }
        } else if (profile.selfInspectionDetected) {
            mode = 'hybrid';
            source = 'rule_based';
            confidence = 0.97;
            reasonCodes.push('arbitration:self_inspection_forced_substantive');
        } else if (
            profile.likelyNeedsOnlyExplanation &&
            !profile.referencesActiveWork &&
            !profile.containsBuildOrFixRequest
        ) {
            mode = 'conversational';
            source = 'rule_based';
            confidence = 0.9;
            reasonCodes.push('arbitration:explanation_defaults_to_conversational');
        } else if (profile.containsBuildOrFixRequest || profile.hasExecutionVerb) {
            mode = 'goal_execution';
            source = profile.referencesActiveWork ? 'continuity' : 'rule_based';
            confidence = profile.referencesActiveWork ? 0.94 : 0.9;
            reasonCodes.push('arbitration:build_fix_prefers_execution');
        } else if (profile.referencesActiveWork) {
            mode = 'hybrid';
            source = 'continuity';
            confidence = 0.88;
            reasonCodes.push('arbitration:active_goal_continuity_sticky');
        } else if (
            profile.hybridWeight >= profile.conversationalWeight &&
            profile.hybridWeight >= profile.goalExecutionWeight
        ) {
            mode = 'hybrid';
            source = 'rule_based';
            confidence = 0.8;
            reasonCodes.push('arbitration:hybrid_bridge_mode');
        } else if (profile.goalExecutionWeight >= 0.65) {
            mode = 'goal_execution';
            source = 'rule_based';
            confidence = 0.82;
            reasonCodes.push('arbitration:goal_execution_threshold');
        }

        const goalIntent: TurnIntentStrength =
            mode === 'goal_execution'
                ? 'strong'
                : mode === 'hybrid'
                    ? 'weak'
                    : 'none';

        const shouldResumeGoal = Boolean(context.request.activeGoalId) && profile.referencesActiveWork;
        const shouldCreateGoal = mode === 'goal_execution' && !context.request.activeGoalId;
        const requiresPlan = mode === 'goal_execution';
        const requiresExecutionLoop = mode === 'goal_execution';
        const authorityLevel: TurnArbitrationDecision['authorityLevel'] =
            mode === 'goal_execution' ? 'full_authority' : 'lightweight';
        const memoryWriteMode: TurnArbitrationDecision['memoryWriteMode'] =
            mode === 'goal_execution'
                ? 'goal_episode'
                : mode === 'hybrid'
                    ? 'episodic'
                    : 'conversation_only';

        const decision: TurnArbitrationDecision = {
            turnId: context.request.turnId,
            mode,
            source,
            confidence,
            reasonCodes,
            goalIntent,
            shouldCreateGoal,
            shouldResumeGoal,
            activeGoalId: context.request.activeGoalId,
            requiresPlan,
            requiresExecutionLoop,
            authorityLevel,
            memoryWriteMode,
            selfInspectionRequest: profile.selfInspectionDetected,
            selfInspectionOperation: profile.selfInspectionOperation,
            selfInspectionRequestedPaths: profile.selfInspectionRequestedPaths,
        };

        const envelope: TurnAuthorityEnvelope = {
            turnId: context.request.turnId,
            mode,
            authorityLevel,
            workflowAuthority: mode === 'goal_execution' || mode === 'hybrid',
            canCreateDurableState: mode === 'goal_execution',
            canReplan: mode === 'goal_execution',
        };

        return { decision, envelope };
    }
}


