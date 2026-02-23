import { ReflectionEvent, ChangeProposal, ChangeCategory, RiskScore } from './types';
import { v4 as uuidv4 } from 'uuid';
import { loadSettings } from '../SettingsManager';

/**
 * Generates actionable change proposals based on reflection events.
 * 
 * Uses the configured LLM (via fetch to the active inference instance)
 * to analyze evidence and produce structured proposals. Falls back to
 * rule-based heuristic generation when no LLM is available.
 * 
 * @capability [CAPABILITY 5.4] LLM-Powered Proposal Generation
 */
export class ProposalEngine {
    private settingsPath: string;

    constructor(settingsPath?: string) {
        this.settingsPath = settingsPath || '';
    }

    /**
     * Analyzes a reflection event and generates 0–N proposals.
     * Attempts LLM-based reasoning first; falls back to heuristic rules.
     */
    async generateProposals(event: ReflectionEvent): Promise<ChangeProposal[]> {
        console.log(`[ProposalEngine] Analyzing reflection: ${event.id}`);

        // Try LLM-powered generation first
        if (this.settingsPath) {
            try {
                const llmProposals = await this.generateWithLLM(event);
                if (llmProposals.length > 0) {
                    console.log(`[ProposalEngine] LLM generated ${llmProposals.length} proposal(s).`);
                    return llmProposals;
                }
            } catch (e: any) {
                console.warn(`[ProposalEngine] LLM generation failed, falling back to heuristics: ${e.message}`);
            }
        }

        // Fallback: rule-based heuristic proposals
        const proposals = this.generateWithHeuristics(event);
        console.log(`[ProposalEngine] Heuristic generated ${proposals.length} proposal(s).`);
        return proposals;
    }

    /**
     * Generates proposals by prompting the active LLM with structured evidence.
     * Uses a direct fetch to the inference endpoint (Ollama or OpenAI-compatible).
     */
    private async generateWithLLM(event: ReflectionEvent): Promise<ChangeProposal[]> {
        const settings = loadSettings(this.settingsPath);
        const inferenceConfig = this.resolveInferenceEndpoint(settings);

        if (!inferenceConfig) {
            throw new Error('No inference endpoint available');
        }

        const systemPrompt = `You are Tala's Reflection Engine. You analyze system errors and tool failures to generate improvement proposals.

Respond ONLY with a valid JSON array of proposals. Each proposal must match this schema:
{
  "category": "bugfix" | "prompt" | "workflow" | "docs" | "test",
  "title": "Short descriptive title (max 80 chars)",
  "description": "Clear explanation of the fix and why it's needed",
  "riskScore": 1-10 (integer),
  "riskReasoning": "Why this risk level",
  "changes": [
    {
      "type": "patch" | "modify" | "create",
      "path": "relative/path/to/file.ts",
      "search": "exact string to find (for patch type only)",
      "replace": "replacement string (for patch type only)",
      "content": "full file content (for create/modify type only)"
    }
  ],
  "rollbackPlan": "How to undo this change"
}

Rules:
- Generate 0 proposals if the evidence doesn't warrant changes
- Generate at most 3 proposals per reflection
- Prefer 'patch' type changes (surgical edits) over full file rewrites
- Only propose changes to files that exist in the project
- Keep risk scores honest: 1-3 = safe, 4-6 = moderate, 7-10 = dangerous
- The 'search' string must be an exact match of existing code`;

        const userPrompt = `Analyze this reflection event and generate improvement proposals:

## Summary
${event.summary}

## Observations
${event.observations.map(o => `- ${o}`).join('\n')}

## Evidence: Errors (${event.evidence.errors.length})
${event.evidence.errors.slice(0, 10).map((e, i) => `${i + 1}. ${e.substring(0, 200)}`).join('\n')}

## Evidence: Failed Tool Calls (${event.evidence.failedToolCalls.length})
${event.evidence.failedToolCalls.slice(0, 5).map((t, i) => `${i + 1}. Tool: ${t.tool} — ${t.error.substring(0, 150)}`).join('\n')}

## Metrics
- Average Latency: ${event.metrics.averageLatencyMs}ms
- Error Rate: ${(event.metrics.errorRate * 100).toFixed(1)}%

Generate a JSON array of proposals (or empty array [] if no actionable changes).`;

        const response = await this.callInference(inferenceConfig, systemPrompt, userPrompt);
        return this.parseProposalResponse(response, event.id);
    }

    /**
     * Resolves the active inference endpoint from settings.
     */
    private resolveInferenceEndpoint(settings: any): { endpoint: string; model: string; engine: string; apiKey?: string } | null {
        // Try configured instances first
        if (settings.inference?.instances?.length > 0) {
            const instance = settings.inference.instances.find(
                (i: any) => i.id === settings.inference?.activeLocalId
            ) || settings.inference.instances[0];

            return {
                endpoint: instance.endpoint || 'http://127.0.0.1:11434',
                model: instance.model || 'llama3',
                engine: instance.engine || 'ollama',
                apiKey: instance.apiKey
            };
        }

        // Try active provider
        if (settings.inference?.activeProviderId && settings.inference?.providers) {
            const provider = settings.inference.providers.find(
                (p: any) => p.id === settings.inference.activeProviderId
            );
            if (provider) {
                return {
                    endpoint: provider.baseUrl || provider.endpoint,
                    model: provider.model || provider.defaultModel,
                    engine: provider.engine || 'openai',
                    apiKey: provider.apiKey
                };
            }
        }

        // Default: local Ollama
        return {
            endpoint: 'http://127.0.0.1:11434',
            model: 'llama3',
            engine: 'ollama'
        };
    }

    /**
     * Calls the inference endpoint directly via fetch.
     * Supports both Ollama and OpenAI-compatible APIs.
     */
    private async callInference(
        config: { endpoint: string; model: string; engine: string; apiKey?: string },
        systemPrompt: string,
        userPrompt: string
    ): Promise<string> {
        const isOllama = config.engine === 'ollama' || config.endpoint.includes('11434');

        const url = isOllama
            ? `${config.endpoint}/api/chat`
            : `${config.endpoint}/v1/chat/completions`;

        const body = isOllama
            ? {
                model: config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                stream: false,
                options: { temperature: 0.3, num_ctx: 8192 }
            }
            : {
                model: config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.3,
                max_tokens: 2048
            };

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.apiKey) {
            headers['Authorization'] = `Bearer ${config.apiKey}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!res.ok) {
                throw new Error(`Inference returned ${res.status}: ${await res.text()}`);
            }

            const data = await res.json() as any;

            // Ollama response format
            if (data.message?.content) return data.message.content;
            // OpenAI response format
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;

            throw new Error('Unexpected response format');
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Parses the LLM's JSON response into validated ChangeProposal objects.
     */
    private parseProposalResponse(response: string, reflectionId: string): ChangeProposal[] {
        try {
            // Extract JSON array from response (LLM might wrap in markdown)
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                console.warn('[ProposalEngine] No JSON array found in LLM response');
                return [];
            }

            const raw = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(raw)) return [];

            // Validate and normalize each proposal
            return raw
                .slice(0, 3) // Max 3 proposals per reflection
                .map((p: any) => this.normalizeProposal(p, reflectionId))
                .filter((p): p is ChangeProposal => p !== null);
        } catch (e: any) {
            console.error('[ProposalEngine] Failed to parse LLM response:', e.message);
            console.debug('[ProposalEngine] Raw response:', response.substring(0, 500));
            return [];
        }
    }

    /**
     * Validates and normalizes a raw proposal object from LLM output.
     */
    private normalizeProposal(raw: any, reflectionId: string): ChangeProposal | null {
        if (!raw.title || !raw.description || !raw.changes?.length) {
            return null;
        }

        const validCategories: ChangeCategory[] = ['prompt', 'workflow', 'bugfix', 'docs', 'test'];
        const category = validCategories.includes(raw.category) ? raw.category : 'bugfix';

        const riskScore = Math.min(10, Math.max(1, Math.round(raw.riskScore || 5))) as RiskScore;

        return {
            id: uuidv4(),
            reflectionId,
            category,
            title: String(raw.title).substring(0, 120),
            description: String(raw.description).substring(0, 500),
            risk: {
                score: riskScore,
                reasoning: String(raw.riskReasoning || 'Auto-assessed by reflection engine.')
            },
            changes: raw.changes.slice(0, 5).map((c: any) => ({
                type: ['patch', 'modify', 'create'].includes(c.type) ? c.type : 'patch',
                path: String(c.path || ''),
                ...(c.search && { search: String(c.search) }),
                ...(c.replace && { replace: String(c.replace) }),
                ...(c.content && { content: String(c.content) })
            })),
            rollbackPlan: String(raw.rollbackPlan || 'Revert the modified files from backup.'),
            status: 'pending'
        };
    }

    /**
     * Generates proposals using hardcoded pattern-matching rules.
     * Used as fallback when no LLM is available.
     */
    private generateWithHeuristics(event: ReflectionEvent): ChangeProposal[] {
        const proposals: ChangeProposal[] = [];

        // Rule 1: Timeout errors → increase timeout
        const timeoutErrors = event.evidence.errors.filter(e => /timeout|timed?\s*out/i.test(e));
        if (timeoutErrors.length >= 2) {
            proposals.push({
                id: uuidv4(),
                reflectionId: event.id,
                category: 'bugfix',
                title: 'Increase timeout for slow operations',
                description: `Detected ${timeoutErrors.length} timeout errors in the last reflection cycle. Consider increasing timeout values for inference or tool execution.`,
                risk: { score: 3 as RiskScore, reasoning: 'Low risk — only changes timing values, does not affect logic.' },
                changes: [],  // Empty changes = advisory-only proposal
                rollbackPlan: 'Revert timeout values to previous defaults.',
                status: 'pending'
            });
        }

        // Rule 2: Repeated tool failures → add error handling or disable tool
        const toolFailures = event.evidence.failedToolCalls;
        if (toolFailures.length >= 3) {
            const failingTools = [...new Set(toolFailures.map(t => t.tool))];
            proposals.push({
                id: uuidv4(),
                reflectionId: event.id,
                category: 'bugfix',
                title: `Harden error handling for ${failingTools.join(', ')}`,
                description: `Tools [${failingTools.join(', ')}] failed ${toolFailures.length} times. Adding try/catch wrappers or input validation may prevent cascading failures.`,
                risk: { score: 4 as RiskScore, reasoning: 'Moderate risk — modifies tool execution paths.' },
                changes: [],
                rollbackPlan: 'Remove added error handling wrappers.',
                status: 'pending'
            });
        }

        // Rule 3: Inference / connection errors → suggest fallback provider
        const inferenceErrors = event.evidence.errors.filter(e =>
            /ECONNREFUSED|ECONNRESET|fetch failed|inference|ollama/i.test(e)
        );
        if (inferenceErrors.length >= 2) {
            proposals.push({
                id: uuidv4(),
                reflectionId: event.id,
                category: 'workflow',
                title: 'Configure fallback inference provider',
                description: `Detected ${inferenceErrors.length} inference connectivity errors. Adding a secondary inference endpoint would improve resilience.`,
                risk: { score: 2 as RiskScore, reasoning: 'Low risk — adds configuration, does not modify existing logic.' },
                changes: [],
                rollbackPlan: 'Remove fallback provider configuration.',
                status: 'pending'
            });
        }

        // Rule 4: High error rate → suggest review
        if (event.metrics.errorRate > 0.5) {
            proposals.push({
                id: uuidv4(),
                reflectionId: event.id,
                category: 'bugfix',
                title: 'High error rate detected — system review recommended',
                description: `Error rate is ${(event.metrics.errorRate * 100).toFixed(0)}%. This exceeds the 50% threshold. A manual review of recent changes is recommended.`,
                risk: { score: 1 as RiskScore, reasoning: 'Advisory only — no automated changes.' },
                changes: [],
                rollbackPlan: 'N/A — advisory proposal.',
                status: 'pending'
            });
        }

        // Rule 5: High latency → suggest optimization
        if (event.metrics.averageLatencyMs > 10000) {
            proposals.push({
                id: uuidv4(),
                reflectionId: event.id,
                category: 'workflow',
                title: 'Reduce inference latency',
                description: `Average latency is ${event.metrics.averageLatencyMs}ms (${(event.metrics.averageLatencyMs / 1000).toFixed(1)}s). Consider using a smaller model, reducing context length, or switching to a faster provider.`,
                risk: { score: 2 as RiskScore, reasoning: 'Advisory — configuration suggestion only.' },
                changes: [],
                rollbackPlan: 'N/A — advisory proposal.',
                status: 'pending'
            });
        }

        return proposals.slice(0, 3); // Max 3 per cycle
    }
}
