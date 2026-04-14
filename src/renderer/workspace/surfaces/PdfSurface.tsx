import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildDisplayFileUrl } from '../WorkspaceSurfaceHelpers';
import { buildSurfaceStateMetadata, getSurfaceState } from '../WorkspaceSurfaceState';
import type { WorkspaceSurfaceControl } from './WorkspaceSurfaceControls';

interface PdfSurfaceState {
    zoom?: number;
    page?: number;
}

export function buildPdfSurfaceControls(state: {
    currentPage: number;
    pageCount: number;
    hasDocument: boolean;
    zoom: number;
}): WorkspaceSurfaceControl[] {
    return [
        { id: 'pdf-prev', label: 'Prev', kind: 'button', disabled: state.currentPage <= 1 },
        { id: 'pdf-next', label: 'Next', kind: 'button', disabled: state.pageCount === 0 || state.currentPage >= state.pageCount },
        { id: 'pdf-zoom-out', label: 'Zoom -', kind: 'button', disabled: !state.hasDocument },
        { id: 'pdf-zoom-in', label: 'Zoom +', kind: 'button', disabled: !state.hasDocument },
        { id: 'pdf-zoom-reset', label: 'Reset', kind: 'button', disabled: !state.hasDocument },
        { id: 'pdf-fit-width', label: 'Fit Width', kind: 'button', disabled: !state.hasDocument },
        { id: 'pdf-page-status', label: 'Page', kind: 'status', value: state.pageCount > 0 ? `${state.currentPage}/${state.pageCount}` : '-' },
        { id: 'pdf-zoom-status', label: 'Zoom', kind: 'status', value: `${Math.round(state.zoom * 100)}%` },
    ];
}

const pdfWorkerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PdfSurface: React.FC<WorkspaceSurfaceProps> = ({
    document: workspaceDocument,
    onSurfaceControlsChange,
    onDocumentMetadataChange,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const persistedState = getSurfaceState<PdfSurfaceState>(workspaceDocument, 'pdf');
    const [zoom, setZoom] = useState(typeof persistedState?.zoom === 'number' ? persistedState.zoom : 1);
    const [error, setError] = useState<string | null>(null);
    const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
    const [pageCount, setPageCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(Math.max(1, typeof persistedState?.page === 'number' ? persistedState.page : 1));

    const src = useMemo(
        () => buildDisplayFileUrl(workspaceDocument.path || workspaceDocument.uri || workspaceDocument.sourceRef || workspaceDocument.payload),
        [workspaceDocument.path, workspaceDocument.uri, workspaceDocument.sourceRef, workspaceDocument.payload]
    );

    useEffect(() => {
        setPdfDoc(null);
        setPageCount(0);
        setCurrentPage(Math.max(1, typeof persistedState?.page === 'number' ? persistedState.page : 1));
        setZoom(typeof persistedState?.zoom === 'number' ? persistedState.zoom : 1);
    }, [workspaceDocument.id]);

    useEffect(() => {
        let cancelled = false;
        let nextPdf: PDFDocumentProxy | null = null;

        async function loadPdf(): Promise<void> {
            if (!src) return;
            try {
                setError(null);
                nextPdf = await getDocument(src).promise;
                if (cancelled) return;
                setPdfDoc(nextPdf);
                setPageCount(nextPdf.numPages);
                setCurrentPage((page) => Math.min(nextPdf!.numPages, Math.max(1, page)));
            } catch (err: any) {
                if (cancelled) return;
                setError(err?.message || 'Failed to load PDF');
                setPdfDoc(null);
                setPageCount(0);
            }
        }

        loadPdf();
        return () => {
            cancelled = true;
            if (nextPdf) {
                nextPdf.destroy().catch(() => undefined);
            }
        };
    }, [src]);

    useEffect(() => {
        let cancelled = false;
        async function renderCurrentPage(): Promise<void> {
            const container = containerRef.current;
            if (!container) return;
            container.innerHTML = '';
            if (!pdfDoc) return;
            try {
                const page = await pdfDoc.getPage(currentPage);
                if (cancelled) return;
                const viewport = page.getViewport({ scale: zoom });
                const canvas = window.document.createElement('canvas');
                const context = canvas.getContext('2d');
                if (!context) return;
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.display = 'block';
                canvas.style.margin = '0 auto';
                container.appendChild(canvas);
                await page.render({ canvasContext: context, viewport }).promise;
            } catch (err: any) {
                if (!cancelled) {
                    setError(err?.message || 'Failed to render PDF page');
                }
            }
        }
        renderCurrentPage();
        return () => {
            cancelled = true;
        };
    }, [currentPage, pdfDoc, zoom]);

    useEffect(() => {
        onSurfaceControlsChange?.({
            controls: buildPdfSurfaceControls({
                currentPage,
                pageCount,
                hasDocument: !!pdfDoc,
                zoom,
            }),
            onControlAction: async (controlId: string) => {
                if (controlId === 'pdf-prev') setCurrentPage((page) => Math.max(1, page - 1));
                if (controlId === 'pdf-next') setCurrentPage((page) => Math.min(pageCount || 1, page + 1));
                if (controlId === 'pdf-zoom-out') setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))));
                if (controlId === 'pdf-zoom-in') setZoom((value) => Math.min(4, Number((value + 0.1).toFixed(2))));
                if (controlId === 'pdf-zoom-reset') setZoom(1);
                if (controlId === 'pdf-fit-width' && pdfDoc && containerRef.current) {
                    const page = await pdfDoc.getPage(currentPage);
                    const baseViewport = page.getViewport({ scale: 1 });
                    const containerWidth = Math.max(200, containerRef.current.clientWidth - 24);
                    const fitZoom = Number((containerWidth / baseViewport.width).toFixed(2));
                    setZoom(Math.max(0.5, Math.min(4, fitZoom)));
                }
            }
        });
        return () => onSurfaceControlsChange?.(null);
    }, [currentPage, onSurfaceControlsChange, pageCount, pdfDoc, zoom]);

    useEffect(() => {
        onDocumentMetadataChange?.(buildSurfaceStateMetadata(workspaceDocument, 'pdf', {
            zoom,
            page: currentPage,
        }));
    }, [currentPage, onDocumentMetadataChange, workspaceDocument, zoom]);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
            {error ? (
                <div style={{ color: '#f99', padding: 12 }}>{error}</div>
            ) : (
                <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 10 }} />
            )}
        </div>
    );
};

export default PdfSurface;
