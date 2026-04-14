import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildDisplayFileUrl, checkAllowedImageSource } from '../WorkspaceSurfaceHelpers';
import { buildSurfaceStateMetadata, getSurfaceState } from '../WorkspaceSurfaceState';
import type { WorkspaceSurfaceControl } from './WorkspaceSurfaceControls';

interface ImageSurfaceState {
    zoom?: number;
    fitToView?: boolean;
}

export function buildImageSurfaceControls(state: {
    hasSource: boolean;
    fitToView: boolean;
    zoom: number;
}): WorkspaceSurfaceControl[] {
    return [
        { id: 'image-zoom-out', label: 'Zoom -', kind: 'button', disabled: !state.hasSource },
        { id: 'image-zoom-in', label: 'Zoom +', kind: 'button', disabled: !state.hasSource },
        { id: 'image-zoom-reset', label: 'Reset', kind: 'button', disabled: !state.hasSource },
        { id: 'image-fit', label: 'Fit', kind: 'toggle', active: state.fitToView, disabled: !state.hasSource },
        { id: 'image-zoom-status', label: 'Zoom', kind: 'status', value: `${Math.round(state.zoom * 100)}%` },
    ];
}

export const ImageSurface: React.FC<WorkspaceSurfaceProps> = ({
    document,
    onSurfaceControlsChange,
    onDocumentMetadataChange,
}) => {
    const persistedState = getSurfaceState<ImageSurfaceState>(document, 'image');
    const [zoom, setZoom] = useState(typeof persistedState?.zoom === 'number' ? persistedState.zoom : 1);
    const [fitToView, setFitToView] = useState(typeof persistedState?.fitToView === 'boolean' ? persistedState.fitToView : true);

    useEffect(() => {
        const state = getSurfaceState<ImageSurfaceState>(document, 'image');
        setZoom(typeof state?.zoom === 'number' ? state.zoom : 1);
        setFitToView(typeof state?.fitToView === 'boolean' ? state.fitToView : true);
    }, [document.id]);

    const src = useMemo(() => {
        if (document.payload && (document.payload.startsWith('data:') || document.payload.startsWith('http'))) {
            return checkAllowedImageSource(document.payload) ? document.payload : '';
        }
        const resolved = buildDisplayFileUrl(document.path || document.uri || document.sourceRef);
        return checkAllowedImageSource(resolved) ? resolved : '';
    }, [document.payload, document.path, document.uri, document.sourceRef]);

    useEffect(() => {
        onSurfaceControlsChange?.({
            controls: buildImageSurfaceControls({
                hasSource: !!src,
                fitToView,
                zoom,
            }),
            onControlAction: (controlId: string) => {
                if (controlId === 'image-zoom-out') {
                    setFitToView(false);
                    setZoom((value) => Math.max(0.25, Number((value - 0.1).toFixed(2))));
                }
                if (controlId === 'image-zoom-in') {
                    setFitToView(false);
                    setZoom((value) => Math.min(5, Number((value + 0.1).toFixed(2))));
                }
                if (controlId === 'image-zoom-reset') {
                    setFitToView(false);
                    setZoom(1);
                }
                if (controlId === 'image-fit') {
                    setFitToView((value) => !value);
                }
            }
        });
        return () => onSurfaceControlsChange?.(null);
    }, [fitToView, onSurfaceControlsChange, src, zoom]);

    useEffect(() => {
        onDocumentMetadataChange?.(buildSurfaceStateMetadata(document, 'image', { zoom, fitToView }));
    }, [document, fitToView, onDocumentMetadataChange, zoom]);

    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', background: '#000', overflow: 'auto' }}>
            {src ? (
                <img
                    src={src}
                    style={{
                        maxWidth: fitToView ? '100%' : 'none',
                        maxHeight: fitToView ? '100%' : 'none',
                        objectFit: fitToView ? 'contain' : 'initial',
                        transform: fitToView ? undefined : `scale(${zoom})`,
                        transformOrigin: 'center center',
                    }}
                    alt={document.title}
                />
            ) : (
                <div style={{ color: '#bbb' }}>Image unavailable</div>
            )}
        </div>
    );
};

export default ImageSurface;
