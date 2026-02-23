import { ReflectionEvent, ChangeProposal, RiskScore } from './types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generates actionable change proposals based on reflection events.
 */
export class ProposalEngine {
    /**
     * Analyzes an event and generates 0-N proposals.
     */
    async generateProposals(event: ReflectionEvent): Promise<ChangeProposal[]> {
        console.log(`[ProposalEngine] Analyzing reflection: ${event.id}`);

        // Mocked generation logic
        const proposals: ChangeProposal[] = [
            {
                id: uuidv4(),
                reflectionId: event.id,
                category: 'bugfix',
                title: 'Extend Terminal Timeout for System Scans',
                description: 'Increases the default timeout for the terminal_run tool to 120s when detecting large recursive scan commands.',
                risk: {
                    score: 5 as RiskScore,
                    reasoning: 'Modifies core tool execution logic. Requires build verification.'
                },
                changes: [
                    {
                        type: 'patch',
                        path: 'electron/services/AgentService.ts',
                        search: 'private static readonly TERMINAL_EXECUTION_TIMEOUT = 30000;',
                        replace: 'private static readonly TERMINAL_EXECUTION_TIMEOUT = 120000;'
                    }
                ],
                rollbackPlan: 'Revert TERMINAL_EXECUTION_TIMEOUT in AgentService.ts to 30000.',
                status: 'pending'
            }
        ];

        console.log(`[ProposalEngine] Generated ${proposals.length} proposals.`);
        return proposals;
    }
}
