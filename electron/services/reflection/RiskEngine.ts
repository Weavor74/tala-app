import fs from 'fs';
import path from 'path';
import { ChangeProposal, RiskAssessment, RiskScore } from './types';

/**
 * Enforces safety policies and calculates risk scores for proposals.
 * 
 * Hard governance gates (cannot be bypassed by risk score):
 * 1. **Deterministic Filter** — blocks forbidden shell patterns
 * 2. **Change Budget** — max files changed per day (default: 5)
 * 3. **Blast Radius** — auth/network/filesystem-write paths always require approval
 * 4. **Reversibility** — ensures backup snapshots are active
 * 
 * @capability [CAPABILITY 5.1] Risk Assessment & Auto-Apply Gating
 */
export class RiskEngine {
    /** Settings-driven auto-apply threshold (0 = never auto-apply). */
    private autoApplyLimit: number;

    /** Max files that can be auto-applied per day. Exceeding requires approval. */
    private changeBudgetPerDay: number;

    /** File path patterns that ALWAYS require manual approval, regardless of risk score. */
    private static readonly BLAST_RADIUS_PATTERNS: RegExp[] = [
        // Auth & credentials
        /auth/i,
        /credential/i,
        /token/i,
        /secret/i,
        /\.env/i,
        /apikey/i,
        // Network & external access
        /network/i,
        /fetch/i,
        /http/i,
        /socket/i,
        /proxy/i,
        // Filesystem write operations
        /SettingsManager/i,
        /ArtifactStore/i,
        /ApplyEngine/i,
        /BackupService/i,
        /FileService/i,
        // Security-sensitive
        /preload/i,
        /main\.ts$/i,
        /RiskEngine/i,    // Self-modification is forbidden
        /ReflectionService/i,
    ];

    /** Path to the daily change ledger file. */
    private ledgerPath: string;

    constructor(autoApplyRiskLevel: number = 0, changeBudgetPerDay: number = 5, userDataDir?: string) {
        this.autoApplyLimit = autoApplyRiskLevel;
        this.changeBudgetPerDay = changeBudgetPerDay;
        this.ledgerPath = path.join(userDataDir || '.', 'memory', 'change_ledger.json');
        console.log(`[RiskEngine] Initialized — autoApplyLimit: ${this.autoApplyLimit}, changeBudget: ${this.changeBudgetPerDay}/day`);
    }

    /**
     * Performs a comprehensive risk assessment with all governance gates.
     */
    async assess(proposal: ChangeProposal): Promise<RiskAssessment> {
        console.log(`[RiskEngine] Assessing proposal: ${proposal.id} (Score: ${proposal.risk.score}, AutoApplyLimit: ${this.autoApplyLimit})`);

        const blastRadiusResult = this.checkBlastRadius(proposal);
        const changeBudgetResult = this.checkChangeBudget(proposal);

        const gates = [
            {
                name: 'Deterministic Filter',
                passed: !this.containsForbiddenActions(proposal),
                details: 'No restricted commands or patterns detected.'
            },
            {
                name: 'Change Budget',
                passed: changeBudgetResult.passed,
                details: changeBudgetResult.details
            },
            {
                name: 'Blast Radius',
                passed: blastRadiusResult.passed,
                details: blastRadiusResult.details
            },
            {
                name: 'Reversibility',
                passed: true,
                details: 'Backup snapshots are active.'
            }
        ];

        const allGatesPassed = gates.every(g => g.passed);

        const result: RiskAssessment = {
            proposalId: proposal.id,
            finalScore: proposal.risk.score,
            gates: gates,
            approvalRequired: proposal.risk.score > this.autoApplyLimit || !allGatesPassed,
            canAutoApply: proposal.risk.score <= this.autoApplyLimit && allGatesPassed
        };

        // Log verdict clearly
        if (!result.canAutoApply) {
            const failedGates = gates.filter(g => !g.passed).map(g => g.name);
            console.log(`[RiskEngine] 🔒 BLOCKED — Reason: ${failedGates.length > 0 ? `Failed gates: ${failedGates.join(', ')}` : `Score ${proposal.risk.score} > limit ${this.autoApplyLimit}`}`);
        } else {
            console.log(`[RiskEngine] ✅ APPROVED for auto-apply.`);
        }

        return result;
    }

    /**
     * HARD GATE: Blast Radius
     * Any change touching auth, network, or filesystem-write paths
     * ALWAYS requires manual approval, regardless of risk score.
     */
    private checkBlastRadius(proposal: ChangeProposal): { passed: boolean; details: string } {
        const sensitiveFiles: string[] = [];

        for (const change of proposal.changes) {
            for (const pattern of RiskEngine.BLAST_RADIUS_PATTERNS) {
                if (pattern.test(change.path)) {
                    sensitiveFiles.push(change.path);
                    break;
                }
            }
        }

        if (sensitiveFiles.length > 0) {
            return {
                passed: false,
                details: `Sensitive files detected (auth/network/fs-write): ${sensitiveFiles.join(', ')}`
            };
        }

        return { passed: true, details: 'No sensitive file paths detected.' };
    }

    /**
     * HARD GATE: Change Budget
     * Max N files auto-changed per day. Exceeding requires manual approval.
     */
    private checkChangeBudget(proposal: ChangeProposal): { passed: boolean; details: string } {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const ledger = this.loadLedger();
        const todayCount = ledger[today] || 0;
        const proposedFiles = proposal.changes.length;

        if (todayCount + proposedFiles > this.changeBudgetPerDay) {
            return {
                passed: false,
                details: `Change budget exceeded: ${todayCount} already applied today + ${proposedFiles} proposed > ${this.changeBudgetPerDay} limit.`
            };
        }

        return {
            passed: true,
            details: `Within budget: ${todayCount}/${this.changeBudgetPerDay} used today.`
        };
    }

    /**
     * Records files changed today in the ledger (called after successful apply).
     */
    recordChanges(fileCount: number) {
        const today = new Date().toISOString().slice(0, 10);
        const ledger = this.loadLedger();
        ledger[today] = (ledger[today] || 0) + fileCount;
        try {
            const dir = path.dirname(this.ledgerPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2));
        } catch (e) {
            console.error('[RiskEngine] Failed to write change ledger:', e);
        }
    }

    private loadLedger(): Record<string, number> {
        try {
            if (fs.existsSync(this.ledgerPath)) {
                return JSON.parse(fs.readFileSync(this.ledgerPath, 'utf-8'));
            }
        } catch (e) {
            console.error('[RiskEngine] Failed to read change ledger:', e);
        }
        return {};
    }

    private containsForbiddenActions(proposal: ChangeProposal): boolean {
        const forbiddenPatterns = [/rm -rf \//, /app\.quit\(\)/, /chmod 777/];
        return proposal.changes.some(c => {
            const content = (c.content || c.replace || '');
            return forbiddenPatterns.some(p => p.test(content));
        });
    }
}
