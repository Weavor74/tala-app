import { v4 as uuidv4 } from 'uuid';
import type {
    EvidenceSufficiencyStatus,
    IterationEffectivenessSnapshot,
    IterationTuningReasonCode,
    IterationTuningRecommendation,
    TuningConfidenceLevel,
} from '../../../shared/planning/IterationEffectivenessTypes';
import type { IterationWorthinessClass, ReplanAllowance } from '../../../shared/planning/IterationPolicyTypes';
import { resolveIterationDoctrineDefaults } from './IterationPolicyResolver';
import type { IterationPolicyAdjustment } from '../../../shared/planning/IterationEffectivenessTypes';

const NON_EXPANDABLE_CLASSES = new Set<IterationWorthinessClass>([
    'operator_sensitive',
    'conversational_explanation',
]);

const MIN_SAMPLE_SIZE = 8;
const MIN_EFFECT_SIZE = 0.1;
const STRONG_EFFECT_SIZE = 0.2;
const HIGH_WASTE_RATE = 0.6;

function rateAtDepth(stats: IterationEffectivenessSnapshot['taskFamilyStats'][number], depth: number): number {
    return stats.depthProfiles.find((item) => item.depth === depth)?.successRate ?? 0;
}

function wasteAtDepth(stats: IterationEffectivenessSnapshot['taskFamilyStats'][number], depth: number): number {
    return stats.depthProfiles.find((item) => item.depth === depth)?.wastedRateAtDepth ?? 0;
}

function determineConfidence(sampleCount: number, strongestSignal: number): TuningConfidenceLevel {
    if (sampleCount >= 24 && strongestSignal >= STRONG_EFFECT_SIZE) return 'high';
    if (sampleCount >= 12 && strongestSignal >= MIN_EFFECT_SIZE) return 'medium';
    return 'low';
}

export class IterationTuningAdvisorService {
    buildRecommendations(
        snapshot: IterationEffectivenessSnapshot,
        currentPolicyOverrides: Partial<Record<IterationWorthinessClass, IterationPolicyAdjustment>> = {},
    ): IterationTuningRecommendation[] {
        const createdAt = snapshot.generatedAt;
        return snapshot.taskFamilyStats.map((stats) => {
            const baseline = resolveIterationDoctrineDefaults(stats.taskClass);
            const currentOverride = currentPolicyOverrides[stats.taskClass];
            const currentMaxIterations = currentOverride?.maxIterations ?? baseline.maxIterations;
            const currentReplanAllowance = currentOverride?.replanAllowance ?? baseline.replanAllowance;
            const successDepth1 = rateAtDepth(stats, 1);
            const successDepth2 = rateAtDepth(stats, 2);
            const successDepth3 = rateAtDepth(stats, 3);
            const secondPassUplift = successDepth2 - successDepth1;
            const thirdPassUplift = successDepth3 - successDepth2;
            const thirdPassWasteRate = wasteAtDepth(stats, 3);
            const replanImprovementRate = stats.replan.improvementRate;
            const replanWorsenedRate = stats.replan.worsenedRate;

            const reasonCodes: IterationTuningReasonCode[] = [];
            let evidenceSufficiency: EvidenceSufficiencyStatus = 'sufficient';

            if (stats.sampleCount < MIN_SAMPLE_SIZE) {
                evidenceSufficiency = 'insufficient_samples';
                reasonCodes.push('tuning.insufficient_samples');
            } else {
                const strongestSignal = Math.max(
                    Math.abs(secondPassUplift),
                    Math.abs(thirdPassUplift),
                    Math.abs(replanImprovementRate - replanWorsenedRate),
                );
                if (strongestSignal < MIN_EFFECT_SIZE) {
                    evidenceSufficiency = 'insufficient_effect_size';
                    reasonCodes.push('tuning.insufficient_effect_size');
                }
                if (
                    secondPassUplift > MIN_EFFECT_SIZE &&
                    thirdPassWasteRate > HIGH_WASTE_RATE &&
                    thirdPassUplift > MIN_EFFECT_SIZE
                ) {
                    evidenceSufficiency = 'mixed_signals';
                    reasonCodes.push('tuning.mixed_signals');
                }
            }

            let recommendedMaxIterations = currentMaxIterations;
            let recommendedReplanAllowance = currentReplanAllowance;

            if (NON_EXPANDABLE_CLASSES.has(stats.taskClass)) {
                if (stats.taskClass === 'operator_sensitive') {
                    reasonCodes.push('tuning.operator_sensitive_no_auto_expand');
                } else {
                    reasonCodes.push('tuning.conversational_non_looping_preserved');
                }
            } else if (evidenceSufficiency === 'sufficient') {
                if (secondPassUplift >= STRONG_EFFECT_SIZE && currentMaxIterations < 2) {
                    recommendedMaxIterations = 2;
                    reasonCodes.push('tuning.strong_second_pass_uplift', 'tuning.recommend_raise_iterations');
                } else if (
                    currentMaxIterations >= 3 &&
                    thirdPassWasteRate >= HIGH_WASTE_RATE &&
                    thirdPassUplift <= MIN_EFFECT_SIZE
                ) {
                    recommendedMaxIterations = 2;
                    reasonCodes.push('tuning.high_third_pass_waste', 'tuning.recommend_lower_iterations');
                } else {
                    reasonCodes.push('tuning.recommend_keep_iterations');
                }

                if (replanImprovementRate >= STRONG_EFFECT_SIZE && replanWorsenedRate < MIN_EFFECT_SIZE) {
                    recommendedReplanAllowance = 'bounded';
                    reasonCodes.push('tuning.replan_helpful', 'tuning.recommend_enable_replan');
                } else if (replanWorsenedRate >= MIN_EFFECT_SIZE && replanImprovementRate < MIN_EFFECT_SIZE) {
                    recommendedReplanAllowance = 'none';
                    reasonCodes.push('tuning.replan_harmful', 'tuning.recommend_disable_replan');
                } else {
                    reasonCodes.push('tuning.recommend_keep_replan');
                }
            } else {
                reasonCodes.push('tuning.recommend_keep_iterations', 'tuning.recommend_keep_replan');
            }

            if (NON_EXPANDABLE_CLASSES.has(stats.taskClass)) {
                recommendedMaxIterations = Math.min(recommendedMaxIterations, currentMaxIterations);
                if (stats.taskClass === 'operator_sensitive') {
                    recommendedReplanAllowance = 'none';
                }
            }

            const strongestSignal = Math.max(
                Math.abs(secondPassUplift),
                Math.abs(thirdPassUplift),
                Math.abs(replanImprovementRate - replanWorsenedRate),
            );
            const confidence = determineConfidence(stats.sampleCount, strongestSignal);

            return {
                recommendationId: `itune-${uuidv4()}`,
                createdAt,
                taskClass: stats.taskClass,
                currentMaxIterations,
                recommendedMaxIterations,
                currentReplanAllowance,
                recommendedReplanAllowance: recommendedReplanAllowance as ReplanAllowance,
                confidence,
                evidenceSufficiency,
                reasonCodes,
                sampleCount: stats.sampleCount,
                secondPassUplift,
                thirdPassUplift,
                thirdPassWasteRate,
                replanImprovementRate,
                replanWorsenedRate,
                status: 'pending',
            };
        });
    }
}
