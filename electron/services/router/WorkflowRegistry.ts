import { ToolService } from '../ToolService';

export interface WorkflowStep {
    name: string;
    tool: string;
    // Function to generate the arguments for this tool, given the output of previous steps
    getArgs: (context: Record<string, any>, initialArgs: any) => any;
    // Function to extract variables from the tool's result to pass to the next steps
    extractVariables?: (result: string, context: Record<string, any>) => void;
}

export interface WorkflowDefinition {
    id: string;
    name: string;
    description: string;
    steps: WorkflowStep[];
}

export class WorkflowRegistry {
    private workflows: Map<string, WorkflowDefinition> = new Map();
    private toolService: ToolService;

    constructor(toolService: ToolService) {
        this.toolService = toolService;
        this.registerDefaultWorkflows();
    }

    private register(workflow: WorkflowDefinition) {
        this.workflows.set(workflow.id, workflow);
    }

    public getWorkflow(id: string): WorkflowDefinition | undefined {
        return this.workflows.get(id);
    }

    public hasWorkflow(id: string): boolean {
        return this.workflows.has(id);
    }

    private registerDefaultWorkflows() {
        this.register({
            id: 'repo_audit',
            name: 'Repository Integrity Audit',
            description: 'Runs standard maintenance checks on the repository.',
            steps: [
                {
                    name: 'Check documentation drift',
                    tool: 'shell_run',
                    getArgs: () => ({ command: 'npm run repo:check' })
                },
                {
                    name: 'Check code hygiene',
                    tool: 'shell_run',
                    getArgs: () => ({ command: 'npm run code:check' })
                }
            ]
        });

        this.register({
            id: 'docs_selfheal',
            name: 'Documentation Self-Healing',
            description: 'Regenerates documentation and commits changes.',
            steps: [
                {
                    name: 'Run documentation generation',
                    tool: 'shell_run',
                    getArgs: () => ({ command: 'npm run docs:selfheal' })
                }
            ]
        });
    }

    /**
     * Executes a registered workflow deterministically.
     * Returns a summarized log of the execution.
     */
    public async executeWorkflow(id: string, initialArgs: any = {}): Promise<string> {
        const workflow = this.workflows.get(id);
        if (!workflow) {
            throw new Error(`Workflow not found: ${id}`);
        }

        let summary = `## Workflow Execution: ${workflow.name}\n\n`;
        const context: Record<string, any> = {};

        for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i];
            summary += `### Step ${i + 1}: ${step.name}\n`;
            
            try {
                const toolDef = this.toolService.getToolDefinition(step.tool);
                if (!toolDef) {
                    summary += `❌ **Error:** Tool '${step.tool}' not found.\n\n`;
                    break;
                }

                const args = step.getArgs(context, initialArgs);
                summary += `*Executing \`${step.tool}\` with args: ${JSON.stringify(args)}*\n\n`;

                const rawResult = await toolDef.execute(args);
                
                let textResult = "";
                if (typeof rawResult === 'object' && rawResult !== null) {
                    textResult = 'result' in rawResult ? String(rawResult.result) : JSON.stringify(rawResult);
                } else {
                    textResult = String(rawResult);
                }

                summary += `✅ **Success:**\n\`\`\`\n${textResult.slice(0, 500)}${textResult.length > 500 ? '...\n(truncated)' : ''}\n\`\`\`\n\n`;

                if (step.extractVariables) {
                    step.extractVariables(textResult, context);
                }

            } catch (e: any) {
                summary += `❌ **Failed:** ${e.message}\n\n`;
                break; // Stop on first failure
            }
        }

        return summary;
    }
}
