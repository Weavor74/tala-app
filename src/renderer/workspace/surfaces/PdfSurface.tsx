import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildDisplayFileUrl } from '../WorkspaceSurfaceHelpers';

const pdfWorkerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PdfSurface: React.FC<WorkspaceSurfaceProps> = ({ document: workspaceDocument }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [error, setError] = useState<string | null>(null);

    const src = useMemo(
        () => buildDisplayFileUrl(workspaceDocument.path || workspaceDocument.uri || workspaceDocument.sourceRef || workspaceDocument.payload),
        [workspaceDocument.path, workspaceDocument.uri, workspaceDocument.sourceRef, workspaceDocument.payload]
    );

    useEffect(() => {
        let cancelled = false;
        let pdf: PDFDocumentProxy | null = null;

        async function render() {
            setError(null);
            const container = containerRef.current;
            if (!container || !src) return;
            container.innerHTML = '';
            try {
                pdf = await getDocument(src).promise;
                for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
                    if (cancelled) return;
                    const page = await pdf.getPage(pageNumber);
                    const viewport = page.getViewport({ scale: zoom });
                    const canvas = window.document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (!ctx) continue;
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    canvas.style.display = 'block';
                    canvas.style.margin = '0 auto 12px auto';
                    container.appendChild(canvas);
                    await page.render({ canvasContext: ctx, viewport }).promise;
                }
            } catch (e: any) {
                setError(e?.message || 'Failed to render PDF');
            }
        }
        render();

        return () => {
            cancelled = true;
            if (pdf) {
                pdf.destroy().catch(() => undefined);
            }
        };
    }, [src, zoom]);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', background: '#252526', color: '#ccc', display: 'flex', gap: 8 }}>
                <button onClick={() => setZoom(z => Math.max(0.5, Number((z - 0.1).toFixed(2))))}>-</button>
                <span style={{ fontSize: 12, minWidth: 55 }}>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom(z => Math.min(3, Number((z + 0.1).toFixed(2))))}>+</button>
            </div>
            {error ? (
                <div style={{ color: '#f99', padding: 12 }}>{error}</div>
            ) : (
                <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 10 }} />
            )}
        </div>
    );
};

export default PdfSurface;
