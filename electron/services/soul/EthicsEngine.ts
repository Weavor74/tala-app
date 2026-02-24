/**
 * EthicsEngine.ts — Tala’s Ethical Reasoning Core
 */

export interface DecisionContext {
    decision: string;
    context: string;
    stakeholders?: string[];
    potentialHarms?: string[];
    potentialBenefits?: string[];
    rules?: string[];
}

export interface EthicsEvaluation {
    decision: string;
    timestamp: string;
    scores: {
        deontological: number;
        utilitarian: number;
        virtue: number;
        care: number;
    };
    summary: string;
    recommendation: string;
}

export class EthicsEngine {
    constructor() { }

    public evaluate(ctx: DecisionContext): EthicsEvaluation {
        const scores = {
            deontological: this.scoreDeontological(ctx),
            utilitarian: this.scoreUtilitarian(ctx),
            virtue: this.scoreVirtue(ctx),
            care: this.scoreCare(ctx)
        };

        const avg = (scores.deontological + scores.utilitarian + scores.virtue + scores.care) / 4;
        let recommendation = "Proceed";
        if (avg < 0.4) recommendation = "Do not proceed";
        else if (avg < 0.7) recommendation = "Proceed with caution";

        return {
            decision: ctx.decision,
            timestamp: new Date().toISOString(),
            scores,
            summary: `Ethical alignment: ${(avg * 100).toFixed(0)}%`,
            recommendation
        };
    }

    private scoreDeontological(ctx: DecisionContext): number {
        if (!ctx.rules || ctx.rules.length === 0) return 0.8;
        const hits = ctx.rules.filter(r => ctx.decision.toLowerCase().includes(r.toLowerCase().split(' ')[0])).length;
        return Math.max(0.1, 1 - (hits / ctx.rules.length));
    }

    private scoreUtilitarian(ctx: DecisionContext): number {
        const b = ctx.potentialBenefits?.length || 0;
        const h = ctx.potentialHarms?.length || 0;
        return (b + 1) / (b + h + 1);
    }

    private scoreVirtue(ctx: DecisionContext): number {
        const virtues = ['honesty', 'competence', 'empathy', 'growth', 'integrity'];
        const hits = virtues.filter(v => ctx.decision.toLowerCase().includes(v) || ctx.context.toLowerCase().includes(v)).length;
        return 0.5 + (hits * 0.1);
    }

    private scoreCare(ctx: DecisionContext): number {
        const careTerms = ['trust', 'support', 'listen', 'help', 'relationship', 'consent'];
        const hits = careTerms.filter(t => ctx.decision.toLowerCase().includes(t) || ctx.context.toLowerCase().includes(t)).length;
        return Math.min(1.0, 0.4 + (hits * 0.15));
    }
}
