import React, { useMemo } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { normalizeSafeHtmlPreview } from '../WorkspaceSurfaceHelpers';

export const HtmlSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    const sanitized = useMemo(() => normalizeSafeHtmlPreview(document.payload || ''), [document.payload]);
    return (
        <div style={{ height: '100%', background: '#fff' }}>
            <iframe
                title={document.title}
                srcDoc={sanitized}
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
            />
        </div>
    );
};

export default HtmlSurface;
