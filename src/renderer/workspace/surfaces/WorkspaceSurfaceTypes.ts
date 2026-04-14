import type React from 'react';
import type { WorkspaceDocument } from '../../types';
import type { WorkspaceSurfaceControlsModel } from './WorkspaceSurfaceControls';

export interface WorkspaceSurfaceProps {
    document: WorkspaceDocument;
    onContentChange?: (content: string) => void;
    onSave?: () => void;
    onEditorKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    onSurfaceControlsChange?: (controls: WorkspaceSurfaceControlsModel | null) => void;
    onDocumentMetadataChange?: (metadata: Record<string, unknown>) => void;
}
