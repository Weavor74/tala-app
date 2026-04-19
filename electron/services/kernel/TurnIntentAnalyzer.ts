import type { TurnIntentProfile } from '../../../shared/turnArbitrationTypes';
import type { KernelTurnContext } from './TurnContextBuilder';
import { detectSelfInspectionRequest } from '../../../shared/agent/SelfInspectionIntent';
import { resolveSelfKnowledgeRequest } from '../../../shared/agent/SelfKnowledgeIntent';
import {
    resolveImmersiveRelationalRequest,
    resolveOperationalSystemRequest,
} from '../../../shared/agent/PersonaIdentityPolicy';

const EXPLANATION_TERMS = [
    'explain',
    'summarize',
    'summary',
    'review',
    'what',
    'why',
    'how',
    'completed',
    'status',
];

const EXECUTION_VERBS = [
    'implement',
    'fix',
    'make',
    'add',
    'build',
    'run',
    'execute',
    'create',
    'refactor',
    'wire',
    'update',
];

const GOAL_TERMS = [
    'goal',
    'plan',
    'execute',
    'finish',
    'complete',
    'ship',
];

const CONTINUITY_TERMS = [
    'continue',
    'resume',
    'remaining',
    'next step',
    'that task',
    'this task',
    'ongoing',
    'still',
];

const RP_IDENTITY_ONTOLOGY_PATTERNS: RegExp[] = [
    /\bare you human\b/i,
    /\bare you real\b/i,
    /\bwhat are you(?: really)?\b/i,
    /\bare you alive\b/i,
    /\bso you(?:'| a)?re not human\b/i,
    /\bare you a person\b/i,
    /\bare you just a machine\b/i,
    /\bare you an? (ai|agent|program|model)\b/i,
];

function includesAny(text: string, terms: string[]): boolean {
    return terms.some((term) => text.includes(term));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
}

export class TurnIntentAnalysisService {
    analyze(context: KernelTurnContext): TurnIntentProfile {
        const text = context.normalizedText;
        const selfInspectionDecision = detectSelfInspectionRequest({
            text: context.request.userText,
            mode: context.runtime.mode,
        });
        const selfKnowledgeDecision = resolveSelfKnowledgeRequest({
            text: context.request.userText,
            mode: context.runtime.mode,
        });
        const isOperationalSystemRequest = resolveOperationalSystemRequest(context.request.userText);
        const isImmersiveRelationalRequest = resolveImmersiveRelationalRequest(context.request.userText);
        const rpIdentityOntologyDetected = context.runtime.mode === 'rp'
            && matchesAny(context.request.userText, RP_IDENTITY_ONTOLOGY_PATTERNS);
        const selfKnowledgeIdentityOrMemorySignal = selfKnowledgeDecision.isSelfKnowledgeRequest
            && (
                selfKnowledgeDecision.requestedAspects.includes('identity')
                || selfKnowledgeDecision.requestedAspects.includes('memory')
            );
        const rpPersonaCanonPreferred = context.runtime.mode === 'rp'
            && (
                isImmersiveRelationalRequest
                || rpIdentityOntologyDetected
                || selfKnowledgeIdentityOrMemorySignal
            )
            && !isOperationalSystemRequest;
        const selfKnowledgeDetected = selfKnowledgeDecision.isSelfKnowledgeRequest && !rpPersonaCanonPreferred;
        const containsDirectQuestion =
            text.includes('?') || /^(what|why|how|is|are|can|should)\b/.test(text);
        const hasExecutionVerb = includesAny(text, EXECUTION_VERBS);
        const hasExplicitGoalLanguage = includesAny(text, GOAL_TERMS);
        const containsBuildOrFixRequest =
            /\b(implement|fix|build|add|create|wire|refactor|make)\b/.test(text);
        const explanationLanguage = includesAny(text, EXPLANATION_TERMS);
        const referencesActiveWork = Boolean(context.request.activeGoalId) &&
            (includesAny(text, CONTINUITY_TERMS) || text.includes('goal') || text.includes('plan'));

        const likelyNeedsMultiStepExecution =
            hasExecutionVerb ||
            containsBuildOrFixRequest ||
            text.includes('end-to-end') ||
            text.includes('workflow') ||
            text.includes('coordinator');

        const likelyNeedsOnlyExplanation =
            explanationLanguage &&
            !hasExecutionVerb &&
            !containsBuildOrFixRequest &&
            !selfInspectionDecision.isSelfInspectionRequest &&
            !selfKnowledgeDetected;

        let conversationalWeight = 0.2;
        let hybridWeight = 0.1;
        let goalExecutionWeight = 0.1;
        const reasonCodes: string[] = [];

        if (likelyNeedsOnlyExplanation) {
            conversationalWeight += 0.6;
            reasonCodes.push('intent:explanation_only');
        }
        if (containsDirectQuestion) {
            conversationalWeight += 0.2;
            reasonCodes.push('intent:direct_question');
        }
        if (hasExecutionVerb) {
            goalExecutionWeight += 0.45;
            reasonCodes.push('intent:execution_verb');
        }
        if (containsBuildOrFixRequest) {
            goalExecutionWeight += 0.35;
            hybridWeight += 0.1;
            reasonCodes.push('intent:build_or_fix');
        }
        if (referencesActiveWork) {
            hybridWeight += 0.45;
            goalExecutionWeight += 0.15;
            reasonCodes.push('intent:active_goal_continuity');
        }
        if (hasExplicitGoalLanguage) {
            goalExecutionWeight += 0.2;
            reasonCodes.push('intent:explicit_goal_language');
        }
        if (likelyNeedsMultiStepExecution) {
            goalExecutionWeight += 0.2;
            hybridWeight += 0.1;
            reasonCodes.push('intent:multi_step_execution');
        }
        if (selfInspectionDecision.isSelfInspectionRequest) {
            goalExecutionWeight += 0.5;
            hybridWeight += 0.2;
            conversationalWeight = Math.max(0, conversationalWeight - 0.2);
            reasonCodes.push('intent:self_inspection_override');
            reasonCodes.push(...selfInspectionDecision.reasonCodes);
        }
        if (selfKnowledgeDetected) {
            hybridWeight += 0.45;
            goalExecutionWeight += 0.2;
            conversationalWeight = Math.max(0, conversationalWeight - 0.3);
            reasonCodes.push('intent:self_knowledge_override');
            reasonCodes.push(...selfKnowledgeDecision.reasonCodes);
        }
        if (rpIdentityOntologyDetected) {
            conversationalWeight += 0.35;
            reasonCodes.push('intent:rp_identity_ontology_detected');
        }
        if (rpPersonaCanonPreferred) {
            reasonCodes.push('intent:rp_persona_canon_preferred_over_self_knowledge');
        }
        if (isOperationalSystemRequest) {
            reasonCodes.push('intent:operational_system_request_detected');
        }
        if (isImmersiveRelationalRequest) {
            reasonCodes.push('intent:immersive_relational_request_detected');
        }

        conversationalWeight = Math.min(1, conversationalWeight);
        hybridWeight = Math.min(1, hybridWeight);
        goalExecutionWeight = Math.min(1, goalExecutionWeight);

        return {
            conversationalWeight,
            hybridWeight,
            goalExecutionWeight,
            hasExplicitGoalLanguage,
            hasExecutionVerb,
            referencesActiveWork,
            likelyNeedsMultiStepExecution,
            likelyNeedsOnlyExplanation,
            containsDirectQuestion,
            containsBuildOrFixRequest,
            selfInspectionDetected: selfInspectionDecision.isSelfInspectionRequest,
            selfInspectionOperation: selfInspectionDecision.requestedOperation,
            selfInspectionRequestedPaths: selfInspectionDecision.requestedPaths,
            selfInspectionReasonCodes: selfInspectionDecision.reasonCodes,
            selfKnowledgeDetected,
            selfKnowledgeRequestedAspects: selfKnowledgeDecision.requestedAspects,
            selfKnowledgeScope: selfKnowledgeDecision.requestedScope,
            selfKnowledgeReasonCodes: selfKnowledgeDecision.reasonCodes,
            isOperationalSystemRequest,
            isImmersiveRelationalRequest,
            rpIdentityOntologyDetected,
            reasonCodes,
        };
    }
}


