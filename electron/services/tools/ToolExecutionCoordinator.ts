import { ToolService } from '../ToolService';

/**
 * ToolExecutionCoordinator
 *
 * A thin, non-invasive wrapper around ToolService that provides a single
 * controlled seam for all tool execution. It delegates directly to
 * ToolService.executeTool() and preserves all existing runtime behavior.
 *
 * Future phases may add retry logic, timeout handling, structured result
 * mapping, or per-tool telemetry at this seam without touching callers.
 *
 * PolicyGate enforcement remains in AgentService (the caller) so that the
 * existing assertSideEffect() check is not disturbed.
 */
export class ToolExecutionCoordinator {
    constructor(private readonly tools: ToolService) {}

    /**
     * Execute a tool by name.
     *
     * Delegates to ToolService.executeTool() unchanged.
     * Callers retain responsibility for PolicyGate checks before invoking this.
     *
     * @param name          Tool name (provider prefixes are stripped inside ToolService).
     * @param args          Key-value arguments for the tool.
     * @param allowedNames  Optional turn-scoped allowlist enforced inside ToolService.
     * @returns             The raw result from the tool (string, ToolResult, or any).
     */
    async executeTool(name: string, args: any, allowedNames?: ReadonlySet<string>): Promise<any> {
        return this.tools.executeTool(name, args, allowedNames);
    }
}
