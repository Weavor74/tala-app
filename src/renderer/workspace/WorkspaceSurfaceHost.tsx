import React, { useEffect, useState } from 'react';
import type { WorkspaceContentType, WorkspaceDocument } from '../types';
import { resolveSurfaceComponent } from './WorkspaceSurfaceRegistry';
import type { WorkspaceSurfaceProps } from './surfaces/WorkspaceSurfaceTypes';
import type { WorkspaceSurfaceControlsModel } from './surfaces/WorkspaceSurfaceControls';

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
    onDocumentMetadataChange,
}) => {
    const [controlsModel, setControlsModel] = useState<WorkspaceSurfaceControlsModel | null>(null);

    useEffect(() => {
        setControlsModel(null);
    }, [document?.id, document?.contentType]);

    if (!document) return null;
    const surfaceType = getSurfaceTypeForDocument(document);
    const Surface = resolveSurfaceComponent(surfaceType);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {controlsModel && controlsModel.controls.length > 0 && (
                <div
                    style={{
                        padding: '6px 10px',
                        background: '#252526',
                        borderBottom: '1px solid #333',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                    }}
                >
                    {controlsModel.controls.map((control) => {
                        if (control.kind === 'status') {
                            return (
                                <span key={control.id} style={{ fontSize: 12, color: '#b9c2d0' }}>
                                    {control.label}{control.value ? `: ${control.value}` : ''}
                                </span>
                            );
                        }
                        return (
                            <button
                                key={control.id}
                                title={control.title}
                                disabled={control.disabled}
                                onClick={() => controlsModel.onControlAction(control.id)}
                                style={{
                                    fontSize: 12,
                                    border: '1px solid #3a4250',
                                    borderRadius: 4,
                                    color: '#e6ebf5',
                                    background: control.active ? '#335e96' : '#1f2430',
                                    padding: '4px 8px',
                                    cursor: control.disabled ? 'not-allowed' : 'pointer',
                                    opacity: control.disabled ? 0.55 : 1,
                                }}
                            >
                                {control.label}
                            </button>
                        );
                    })}
                </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
                <Surface
                    document={document}
                    onContentChange={onContentChange}
                    onSave={onSave}
                    onEditorKeyDown={onEditorKeyDown}
                    onSurfaceControlsChange={setControlsModel}
                    onDocumentMetadataChange={onDocumentMetadataChange}
                />
            </div>
        </div>
    );
};

export default WorkspaceSurfaceHost;
