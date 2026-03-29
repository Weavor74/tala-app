/**
 * GovernancePolicyEngine.ts — Phase 3.5 P3.5C
 *
 * Deterministic approval policy engine.
 *
 * Evaluates a GovernancePolicyInput against a GovernancePolicy and returns a
 * GovernanceEvaluationResult.
 *
 * Design rules:
 * - No I/O, no async, no model calls.
 * - Same input always yields the same output.
 * - Rules within a policy are AND-evaluated per rule, OR-accumulated across rules.
 * - Most restrictive tier across all matching rules wins.
 * - selfAuthorizationPermitted is only true when tier is tala_self_* AND
 *   policy.selfAuthorizationDisabled is false.
 * - blockedByPolicy is true for 'blocked' or 'emergency_manual_only' tiers.
 */

import type {
    GovernancePolicy,
    GovernancePolicyInput,
    GovernanceEvaluationResult,
    GovernanceRule,
    GovernanceRuleCondition,
    GovernanceBlockReason,
    AuthorityTier,
} from '../../../shared/governanceTypes';
import {
    mostRestrictiveTier,
    tierAllowsSelfAuthorization,
    approvalsRequired,
} from './AuthorityTierModel';

// ─── GovernancePolicyEngine ───────────────────────────────────────────────────

export class GovernancePolicyEngine {

    /**
     * Evaluates the given input against the policy.
     * Returns a deterministic GovernanceEvaluationResult.
     */
    evaluate(input: GovernancePolicyInput, policy: GovernancePolicy): GovernanceEvaluationResult {
        const evaluatedAt = new Date().toISOString();

        const matchedRules: GovernanceRule[] = [];
        const tiersFromRules: AuthorityTier[] = [];

        for (const rule of policy.rules) {
            if (this._ruleMatches(rule, input)) {
                matchedRules.push(rule);
                tiersFromRules.push(rule.requiredTier);
            }
        }

        const resolvedTier = tiersFromRules.length > 0
            ? mostRestrictiveTier(tiersFromRules)
            : policy.defaultTier;

        const requiresManualConfirmation = matchedRules.some(r => r.requiresManualConfirmation);
        const escalateOnVerificationFailure = matchedRules.some(r => r.escalateOnVerificationFailure);

        const selfAuthorizationPermitted =
            tierAllowsSelfAuthorization(resolvedTier) && !policy.selfAuthorizationDisabled;

        const blockedByPolicy = resolvedTier === 'blocked' || resolvedTier === 'emergency_manual_only';

        let blockReason: GovernanceBlockReason | undefined;
        if (resolvedTier === 'blocked') {
            blockReason = 'policy_blocked';
        } else if (resolvedTier === 'emergency_manual_only') {
            blockReason = 'emergency_manual_only';
        } else if (policy.selfAuthorizationDisabled && tierAllowsSelfAuthorization(resolvedTier)) {
            blockReason = 'self_authorization_disabled';
        }

        const contributingConditions = matchedRules.flatMap(r =>
            r.conditions.map(c => `${r.ruleId}:${c.field}${c.operator}${String(c.value)}`),
        );

        return {
            evaluatedAt,
            proposalId: input.proposalId,
            policyId: policy.policyId,
            policyVersion: policy.version,
            resolvedTier,
            matchedRules: matchedRules.map(r => ({
                ruleId: r.ruleId,
                label: r.label,
                rationale: r.rationale,
            })),
            requiresManualConfirmation,
            escalateOnVerificationFailure,
            selfAuthorizationPermitted,
            blockedByPolicy,
            blockReason,
            approvalsRequired: approvalsRequired(resolvedTier),
            contributingConditions,
        };
    }

    // ── Private rule matching ───────────────────────────────────────────────────

    /**
     * Returns true when ALL conditions of a rule match the input.
     */
    private _ruleMatches(rule: GovernanceRule, input: GovernancePolicyInput): boolean {
        return rule.conditions.every(c => this._conditionMatches(c, input));
    }

    /**
     * Evaluates a single condition against the input.
     */
    private _conditionMatches(
        condition: GovernanceRuleCondition,
        input: GovernancePolicyInput,
    ): boolean {
        const rawValue = this._getField(condition.field, input);
        const { operator, value } = condition;

        switch (operator) {
            case 'eq':
                return rawValue === value;
            case 'neq':
                return rawValue !== value;
            case 'gte':
                return typeof rawValue === 'number' && typeof value === 'number'
                    ? rawValue >= value
                    : false;
            case 'lte':
                return typeof rawValue === 'number' && typeof value === 'number'
                    ? rawValue <= value
                    : false;
            case 'gt':
                return typeof rawValue === 'number' && typeof value === 'number'
                    ? rawValue > value
                    : false;
            case 'lt':
                return typeof rawValue === 'number' && typeof value === 'number'
                    ? rawValue < value
                    : false;
            case 'in':
                return Array.isArray(value)
                    ? value.includes(rawValue as string)
                    : false;
            case 'contains':
                return Array.isArray(rawValue)
                    ? (rawValue as string[]).includes(value as string)
                    : typeof rawValue === 'string' && typeof value === 'string'
                        ? rawValue.includes(value)
                        : false;
            default:
                return false;
        }
    }

    /**
     * Extracts the relevant field value from the input.
     */
    private _getField(
        field: GovernanceRuleCondition['field'],
        input: GovernancePolicyInput,
    ): string | number | boolean | string[] {
        switch (field) {
            case 'safetyClass':                 return input.safetyClass;
            case 'riskScore':                   return input.riskScore;
            case 'targetSubsystem':             return input.targetSubsystem;
            case 'isProtectedSubsystem':        return input.isProtectedSubsystem;
            case 'hasProtectedFile':            return input.hasProtectedFile;
            case 'fileCount':                   return input.fileCount;
            case 'mutationType':                return input.mutationTypes;
            case 'rollbackStrategy':            return input.rollbackStrategy;
            case 'verificationManualRequired':  return input.verificationManualRequired;
            case 'hasInvariantSensitivity':     return input.hasInvariantSensitivity;
            default:
                return false;
        }
    }
}
