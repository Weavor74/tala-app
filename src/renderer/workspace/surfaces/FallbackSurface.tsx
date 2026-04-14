import React from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';

export const FallbackSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    return (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', background: '#1e1e1e' }}>
            <div style={{ textAlign: 'center', maxWidth: 520 }}>
                <h3 style={{ marginBottom: 8 }}>Unsupported Document Surface</h3>
                <p style={{ margin: 0 }}>
                    Could not render "{document.title}" as <code>{document.contentType}</code>.
                </p>
            </div>
        </div>
    );
};

export default FallbackSurface;

