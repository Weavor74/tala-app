import path from 'path';
import { ArtifactType, WorkspaceArtifact, AgentTurnOutput } from '../types/artifacts';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// Namespace for stable IDs (Tala Artifact Namespace)
const TALA_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * ArtifactRouter
 * 
 * Logic to decide whether content belongs in chat or in the workspace.
 * Prevents large documents and technical assets from flooding chat.
 */
export class ArtifactRouter {

    /**
     * Normalizes agent output into a structured AgentTurnOutput.
     * Decisions are based on content length, content type, and tool results.
     */
    public normalizeAgentOutput(message: string, toolResults?: any[]): AgentTurnOutput {
        // 1. Initial output configuration
        const output: AgentTurnOutput = {
            message: message,
            artifact: null,
            suppressChatContent: false
        };

        // 2. CHECK FOR EXPLICIT OVERRIDE (User wants it in chat)
        if (this.detectRawContentOverride(message)) {
            console.log(`[ArtifactRouter] RAW_CONTENT_OVERRIDE DETECTED. Bypassing artifact routing.`);
            return output;
        }

        // 3. Scan tool results for candidates
        if (toolResults && toolResults.length > 0) {
            for (const res of toolResults) {
                const artifact = this.resolveWorkspaceArtifact(res);
                if (artifact) {
                    output.artifact = artifact;

                    // Significant artifacts (code, html, large docs) trigger suppression
                    if (message.length > 500 || ['editor', 'code', 'html', 'browser', 'diff', 'pdf'].includes(artifact.type)) {
                        output.suppressChatContent = true;
                    }
                    break;
                }
            }
        }

        // 4. Post-processing: If message itself is an artifact (e.g. raw markdown or HTML)
        if (!output.artifact) {
            if (this.isLikelyHtml(message)) {
                output.artifact = {
                    id: this.generateStableId(message, 'html'),
                    type: 'html',
                    content: message,
                    createdAt: new Date().toISOString(),
                    source: 'agent',
                    title: 'HTML Preview'
                };
                output.suppressChatContent = true;
            } else if (message.length > 2000) {
                output.artifact = {
                    id: this.generateStableId(message, 'md'),
                    type: 'markdown',
                    content: message,
                    createdAt: new Date().toISOString(),
                    source: 'agent',
                    title: 'Generated Document'
                };
                output.suppressChatContent = true;
            }
        }

        // 5. If suppressChatContent is true, provide a concise summary if not already present
        if (output.suppressChatContent && output.artifact) {
            const messageLen = output.message?.length || 0;
            const isJustContent = messageLen > 1000 || (output.artifact.type === 'html' && output.message?.includes('<!DOCTYPE'));
            if (isJustContent) {
                output.message = this.getArtifactSummary(output.artifact);
            }
        }

        return output;
    }

    /**
     * Resolves a tool execution result into a workspace artifact if applicable.
     */
    /**
     * Resolves a tool execution result into a workspace artifact if applicable.
     */
    public resolveWorkspaceArtifact(res: any): WorkspaceArtifact | null {
        if (!res) return null;

        // 1. If it's a wrapper from AgentService including tool metadata
        if (res.name && res.args) {
            const toolName = res.name;
            const args = res.args;
            const content = res.result;

            if (toolName === 'fs_read_text' && args.path) {
                return {
                    id: this.generateStableId(args.path, 'editor'),
                    type: this.inferArtifactTypeFromPath(args.path),
                    path: args.path,
                    content: content,
                    title: path.basename(args.path),
                    createdAt: new Date().toISOString(),
                    source: 'tool'
                };
            }

            if ((toolName === 'browser_navigate' || toolName === 'browse') && args.url) {
                return {
                    id: this.generateStableId(args.url, 'browser'),
                    type: 'browser',
                    url: args.url,
                    title: 'Web Page',
                    createdAt: new Date().toISOString(),
                    source: 'tool'
                };
            }

            // Fallback: search the raw result string
            return this.resolveFromRawResult(content);
        }

        // 2. Already structured tool results (e.g. from adapted tools)
        if (typeof res === 'object' && res.type && (res.path || res.url || res.content)) {
            return {
                id: this.generateStableId(res.path || res.url || res.content, res.type),
                createdAt: new Date().toISOString(),
                ...res
            };
        }

        // 3. Raw string result heuristics
        return this.resolveFromRawResult(res);
    }

    private resolveFromRawResult(toolResult: any): WorkspaceArtifact | null {
        const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

        // 1. Detect URLs
        const urlMatch = content.match(/^https?:\/\/[^\s/$.?#].[^\s]*$/i);
        if (urlMatch) {
            return {
                id: this.generateStableId(urlMatch[0], 'browser'),
                type: 'browser',
                url: urlMatch[0],
                title: 'Browser',
                createdAt: new Date().toISOString(),
                source: 'tool'
            };
        }

        // 2. Detect JSON
        if (content.trim().startsWith('{') && content.trim().endsWith('}')) {
            try {
                JSON.parse(content);
                return {
                    id: this.generateStableId(content, 'json'),
                    type: 'json',
                    content: content,
                    title: 'JSON Data',
                    createdAt: new Date().toISOString(),
                    source: 'tool'
                };
            } catch (e) { }
        }

        return null;
    }

    /**
     * Determines if the user explicitly asked for raw content in chat.
     */
    private detectRawContentOverride(message: string): boolean {
        const lower = message.toLowerCase();
        const phrases = [
            'paste it here',
            'show the raw',
            'put the full text in chat',
            'print the whole',
            'show full contents here',
            'in the chat'
        ];
        return phrases.some(p => lower.includes(p));
    }

    /**
     * Infers artifact type from a file path.
     */
    public inferArtifactTypeFromPath(filePath: string, context?: any): ArtifactType {
        const ext = path.extname(filePath).toLowerCase();

        if (context?.mode === 'preview' || context?.isHtml) return 'html';
        if (context?.isDiff) return 'diff';

        switch (ext) {
            case '.md':
            case '.markdown':
                return 'markdown';
            case '.txt':
            case '.log':
                return 'text';
            case '.json':
                return 'json';
            case '.html':
                return 'html';
            case '.pdf':
                return 'pdf';
            case '.ts':
            case '.tsx':
            case '.js':
            case '.jsx':
            case '.py':
            case '.python':
            case '.css':
            case '.cpp':
            case '.c':
            case '.h':
            case '.cs':
            case '.go':
            case '.rs':
            case '.java':
            case '.sh':
            case '.sql':
            case '.yaml':
            case '.yml':
                return 'editor'; // Source files default to editor
            case '.png':
            case '.jpg':
            case '.jpeg':
            case '.gif':
            case '.svg':
            case '.webp':
            case '.bmp':
                return 'image';
            default:
                return 'text';
        }
    }

    /**
     * Generates a stable unique ID based on target content or path.
     * Prevents duplicate tabs for the same resource.
     */
    public generateStableId(target: string, type: string): string {
        if (!target) return uuidv4();
        // Use v5 UUID for deterministic generation based on the target string
        return uuidv5(`${type}:${target}`, TALA_NAMESPACE);
    }

    private isLikelyHtml(text: string): boolean {
        const trimmed = text.trim();
        return (trimmed.startsWith('<!DOCTYPE html>') || (trimmed.startsWith('<html') && trimmed.endsWith('</html>')));
    }

    private getArtifactSummary(artifact: WorkspaceArtifact): string {
        const action = ['editor', 'code'].includes(artifact.type) ? 'Opened' : 'Rendered';
        const target = artifact.path ? `\`${path.basename(artifact.path)}\`` : artifact.title || 'the content';
        const destination = ['editor', 'code'].includes(artifact.type) ? 'in the editor' : 'in the view pane';

        return `${action} ${target} ${destination}.`;
    }
}

export const artifactRouter = new ArtifactRouter();
