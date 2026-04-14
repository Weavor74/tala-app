import React from 'react';
import type { WorkspaceContentType, WorkspaceDocument } from '../types';
import { resolveSurfaceComponent } from './WorkspaceSurfaceRegistry';
import type { WorkspaceSurfaceProps } from './surfaces/WorkspaceSurfaceTypes';

export function getSurfaceTypeForDocument(doc: WorkspaceDocument): WorkspaceContentType {
    return doc.contentType || 'unknown';
}

export interface WorkspaceSurfaceHostProps extends Omit<WorkspaceSurfaceProps, 'document'> {
    document: WorkspaceDocument | null | undefined;
}

export const WorkspaceSurfaceHost: React.FC<WorkspaceSurfaceHostProps> = ({
    document,
    onContentChange,
    onSave,
    onEditorKeyDown,
}) => {
    if (!document) return null;
    const surfaceType = getSurfaceTypeForDocument(document);
    const Surface = resolveSurfaceComponent(surfaceType);

    return (
        <Surface
            document={document}
            onContentChange={onContentChange}
            onSave={onSave}
            onEditorKeyDown={onEditorKeyDown}
        />
    );
};

export default WorkspaceSurfaceHost;
