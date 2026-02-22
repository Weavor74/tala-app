export interface A2UIComponent {
    id: string;
    type: string;
    props?: Record<string, any>;
    children?: A2UIComponent[];
}

export interface A2UIState {
    components: A2UIComponent[];
}

export type TabType = 'file' | 'browser' | 'a2ui' | 'settings' | 'profile' | 'search' | 'library' | 'sessions' | 'memory' | 'workflow' | 'conflict';

export interface Tab {
    id: string; /** Unique ID for the tab */
    type: TabType;
    title: string;
    data?: any; /** For file content, browser URL, etc. */
    active: boolean; /** Whether the tab is currently active */
    scrollPosition?: number;
    conflictPath?: string; // Specific for conflict tabs
}
