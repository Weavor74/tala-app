/**
 * Workspace & Application Primitives
 * 
 * Core structural types for the TALA renderer, focusing on the dynamic UI
 * protocol (A2UI) and the tab management system.
 */
export interface A2UIComponent {
    /** Unique identifier for the UI node. */
    id: string;
    /** The component type (mapped in BasicComponents.tsx). */
    type: string;
    /** Raw props passed to the React component. */
    props?: Record<string, any>;
    /** Recursive children array. */
    children?: A2UIComponent[];
}

export interface A2UIState {
    /** The current component tree received from the agent. */
    components: A2UIComponent[];
}

export type WorkspaceContentType =
    | 'text'
    | 'html'
    | 'board'
    | 'rtf'
    | 'pdf'
    | 'image'
    | 'unknown';

export interface WorkspaceDocument {
    id: string;
    title: string;
    path?: string;
    uri?: string;
    mimeType?: string;
    contentType: WorkspaceContentType;
    dirty: boolean;
    readOnly: boolean;
    payload?: string;
    sourceRef?: string;
    metadata?: Record<string, unknown>;
}

export type TabType = 'file' | 'browser' | 'a2ui' | 'settings' | 'profile' | 'search' | 'library' | 'sessions' | 'memory' | 'workflow' | 'conflict' | 'artifact';

export interface Tab {
    id: string; /** Unique ID for the tab */
    type: TabType;
    title: string;
    data?: any; /** For file content, browser URL, etc. */
    active: boolean; /** Whether the tab is currently active */
    scrollPosition?: number;
    conflictPath?: string; // Specific for conflict tabs
    artifact?: WorkspaceArtifact;
    document?: WorkspaceDocument;
}

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
