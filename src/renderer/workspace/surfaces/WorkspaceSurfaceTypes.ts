import type React from 'react';
import type { WorkspaceDocument } from '../../types';

export interface WorkspaceSurfaceProps {
    document: WorkspaceDocument;
    onContentChange?: (content: string) => void;
    onSave?: () => void;
    onEditorKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}
