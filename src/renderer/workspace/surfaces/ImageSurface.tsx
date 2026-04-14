import React, { useMemo } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildDisplayFileUrl } from '../WorkspaceSurfaceHelpers';

export const ImageSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    const src = useMemo(() => {
        if (document.payload && (document.payload.startsWith('data:') || document.payload.startsWith('http'))) {
            return document.payload;
        }
        return buildDisplayFileUrl(document.path || document.uri || document.sourceRef);
    }, [document.payload, document.path, document.uri, document.sourceRef]);

    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', background: '#000' }}>
            {src ? (
                <img src={src} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} alt={document.title} />
            ) : (
                <div style={{ color: '#bbb' }}>Image unavailable</div>
            )}
        </div>
    );
};

export default ImageSurface;
