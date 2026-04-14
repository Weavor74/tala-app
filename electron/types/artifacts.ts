/**
 * Artifact Primitives for the Tala Workspace
 */

export type ArtifactType =
    | "text"
    | "markdown"
    | "editor"
    | "diff"
    | "html"
    | "browser"
    | "report"
    | "json"
    | "code"
    | "image"
    | "pdf"
    | "rtf"
    | "board";

export interface WorkspaceArtifact {
    id: string;
    type: ArtifactType;
    title?: string;
    path?: string;
    content?: string;
    url?: string;
    language?: string;
    readOnly?: boolean;
    mimeType?: string;
    createdAt: string;
    source?: "agent" | "tool" | "system";
    metadata?: Record<string, unknown>;
}

export interface AgentTurnOutput {
    message?: string;
    artifact?: WorkspaceArtifact | null;
    suppressChatContent?: boolean;
    /** Human-readable reason for the routing decision (for audit telemetry). */
    routingReason?: string;
    /** The output channel that received this turn's content. */
    outputChannel?: 'chat' | 'workspace' | 'browser' | 'diff' | 'fallback';
}
