import React, { useMemo } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildDisplayFileUrl, checkAllowedImageSource } from '../WorkspaceSurfaceHelpers';

export const ImageSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    const src = useMemo(() => {
        if (document.payload && (document.payload.startsWith('data:') || document.payload.startsWith('http'))) {
            return checkAllowedImageSource(document.payload) ? document.payload : '';
        }
        const resolved = buildDisplayFileUrl(document.path || document.uri || document.sourceRef);
        return checkAllowedImageSource(resolved) ? resolved : '';
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
