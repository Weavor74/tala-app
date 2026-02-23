import { IBrain } from '../../brains/IBrain';
import { Strategy, StrategicSimulation } from './strategyTypes';
import { GoalNode } from './types';
import { v4 as uuidv4 } from 'uuid';

/**
 * StrategyEngine (The Navigator)
 * 
 * Responsible for generating and evaluating multiple implementation paths ("Flight Paths")
 * for complex goals. It uses the LLM to brainstorm distinct approaches and then
 * applies scoring for risk and cost.
 */
export class StrategyEngine {
    private brain: IBrain;

    constructor(brain: IBrain) {
        this.brain = brain;
    }

    public setBrain(brain: IBrain) {
        this.brain = brain;
    }

    /**
     * Generates a set of competing strategies for a given goal.
     */
    public async computePaths(goal: GoalNode, workspaceOverview: string, astroVector?: Record<string, number>): Promise<StrategicSimulation> {
        console.log(`[StrategyEngine] Computing paths for goal: ${goal.title}`);

        const modulation = this.calculateModulation(astroVector);

        const prompt = `
[MISSION OBJECTIVE]
Goal: ${goal.title}
Description: ${goal.description}

[WORKSPACE CONTEXT]
${workspaceOverview}

[ASTRO-MODULATION]
${modulation.text}

[TASK]
You are the Navigation Computer for an advanced starship. You must calculate 3 DISTINCT "Flight Paths" (strategies) to achieve the MISSION OBJECTIVE.

Required Path Types:
1. SAFE PATH: Maximum stability, minimal risk, likely slower or more verbose. (Hull Integrity oriented).
2. DIRECT PATH: Balanced, standard engineering approach. (Efficiency oriented).
3. EXPERIMENTAL PATH: High-speed, high-risk, potentially using shortcuts or advanced patterns. (Time-critical).

For each path, provide:
- Name
- Immersion (Star Citizen flavor: mention ships, fuel, sectors, or hazards)
- Rationale (Technical explanation)
- Steps (4-6 atomic steps)
- Risk Score (1-10)
- Cost Score (1-10)

FORMAT: Return ONLY a valid JSON array of Strategy objects.
`;

        const response = await this.brain.generateResponse([
            { role: 'system', content: "You are the Ship's Navigation Computer. Output ONLY JSON." },
            { role: 'user', content: prompt }
        ]);

        let paths: Strategy[] = [];
        try {
            // Clean response string of any markdown markers
            const jsonStr = response.content.replace(/```json|```/g, '').trim();
            const rawPaths = JSON.parse(jsonStr);

            paths = rawPaths.map((p: any) => ({
                id: uuidv4(),
                name: p.name || "Unnamed Path",
                immersion: p.immersion || "Standard trajectory.",
                rationale: p.rationale || "No rationale provided.",
                steps: p.steps || [],
                riskScore: p.riskScore || 5,
                estimatedCost: p.estimatedCost || 5,
                tokenEstimate: 0 // Will be calculated during execution
            }));
        } catch (e) {
            console.error("[StrategyEngine] Failed to parse paths, using fallback.", e);
            paths = [this.getFallbackPath(goal)];
        }

        return {
            goalId: goal.id,
            paths,
            recommendedIndex: 0, // Usually the safest is first
            timestamp: new Date().toISOString()
        };
    }

    private getFallbackPath(goal: GoalNode): Strategy {
        return {
            id: uuidv4(),
            name: "Standard Trajectory",
            immersion: "Nav-com is recalibrating sensors. Proceeding with standard thrusters.",
            rationale: "Default fallback path.",
            steps: ["Analyze requirements", "Modify files", "Verify changes"],
            riskScore: 3,
            estimatedCost: 3,
            tokenEstimate: 1000
        };
    }

    private calculateModulation(vector?: Record<string, number>): { text: string; multipliers: { risk: number; cost: number } } {
        if (!vector) return { text: "Sensors nominal. No planetary modulation applied.", multipliers: { risk: 1.0, cost: 1.0 } };

        const stability = vector['stability'] ?? 0.5;
        const clarity = vector['clarity'] ?? 0.5;
        const intensity = vector['intensity'] ?? 0.5;

        let riskMult = 1.0;
        let costMult = 1.0;
        let advice = "Planetary alignment suggests ";

        if (stability < 0.4) {
            riskMult = 1.5;
            advice += "high volatility (inflate risk scores). ";
        }
        if (clarity < 0.4) {
            costMult = 1.3;
            advice += "unclear trajectories (inflate fuel/token estimates). ";
        }
        if (intensity > 0.7) {
            advice += "high solar intensity (prefer experimental/direct paths). ";
        }

        return {
            text: advice,
            multipliers: { risk: riskMult, cost: costMult }
        };
    }
}
