import React, { useMemo } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildSandboxedPreviewDocument, convertRtfToPreviewHtml, normalizeSafeHtmlPreview } from '../WorkspaceSurfaceHelpers';

export const RtfSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    const previewHtml = useMemo(
        () => buildSandboxedPreviewDocument(normalizeSafeHtmlPreview(convertRtfToPreviewHtml(document.payload || ''))),
        [document.payload]
    );
    return (
        <div style={{ height: '100%', background: '#fff' }}>
            <div style={{ padding: '8px 12px', background: '#252526', color: '#ccc', borderBottom: '1px solid #333', fontSize: 12 }}>
                RTF Preview (Read Only)
            </div>
            <iframe
                title={`${document.title}-rtf-preview`}
                srcDoc={previewHtml}
                sandbox=""
                style={{ width: '100%', height: 'calc(100% - 36px)', border: 'none' }}
            />
        </div>
    );
};

export default RtfSurface;
