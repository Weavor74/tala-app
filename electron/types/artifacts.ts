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
    | "pdf";

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
}
