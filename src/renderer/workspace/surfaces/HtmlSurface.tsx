import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildSandboxedPreviewDocument, normalizeSafeHtmlPreview } from '../WorkspaceSurfaceHelpers';
import { buildSurfaceStateMetadata, getSurfaceState } from '../WorkspaceSurfaceState';
import type { WorkspaceSurfaceControl } from './WorkspaceSurfaceControls';

interface HtmlSurfaceState {
    fitToPane?: boolean;
}

export function buildHtmlSurfaceControls(state: {
    fitToPane: boolean;
    htmlSize: number;
}): WorkspaceSurfaceControl[] {
    return [
        { id: 'html-reload', label: 'Reload', kind: 'button' },
        { id: 'html-fit', label: 'Fit Content', kind: 'toggle', active: state.fitToPane },
        { id: 'html-size', label: 'Preview Size', kind: 'status', value: `${state.htmlSize} chars` },
    ];
}

export const HtmlSurface: React.FC<WorkspaceSurfaceProps> = ({
    document,
    onSurfaceControlsChange,
    onDocumentMetadataChange,
}) => {
    const persistedState = getSurfaceState<HtmlSurfaceState>(document, 'html');
    const [fitToPane, setFitToPane] = useState(typeof persistedState?.fitToPane === 'boolean' ? persistedState.fitToPane : false);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        const state = getSurfaceState<HtmlSurfaceState>(document, 'html');
        setFitToPane(typeof state?.fitToPane === 'boolean' ? state.fitToPane : false);
        setReloadToken(0);
    }, [document.id]);

    const sanitizedHtml = useMemo(() => normalizeSafeHtmlPreview(document.payload || ''), [document.payload]);
    const previewDocument = useMemo(
        () => buildSandboxedPreviewDocument(sanitizedHtml, { fitToPane }),
        [fitToPane, sanitizedHtml]
    );

    useEffect(() => {
        onSurfaceControlsChange?.({
            controls: buildHtmlSurfaceControls({ fitToPane, htmlSize: sanitizedHtml.length }),
            onControlAction: (controlId: string) => {
                if (controlId === 'html-reload') setReloadToken((value) => value + 1);
                if (controlId === 'html-fit') setFitToPane((value) => !value);
            }
        });
        return () => onSurfaceControlsChange?.(null);
    }, [fitToPane, onSurfaceControlsChange, sanitizedHtml.length]);

    useEffect(() => {
        onDocumentMetadataChange?.(buildSurfaceStateMetadata(document, 'html', { fitToPane }));
    }, [document, fitToPane, onDocumentMetadataChange]);

    return (
        <div style={{ height: '100%', background: '#fff' }}>
            <iframe
                key={`${document.id}:${reloadToken}`}
                title={document.title}
                srcDoc={previewDocument}
                sandbox=""
                referrerPolicy="no-referrer"
                style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
            />
        </div>
    );
};

export default HtmlSurface;
