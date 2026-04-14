import { describe, expect, it } from 'vitest';
import { resolveWorkspaceContentType } from '../src/renderer/workspace/WorkspaceContentTypeResolver';
import { createWorkspaceDocumentFromFile } from '../src/renderer/workspace/WorkspaceDocumentFactory';
import { getSurfaceTypeForDocument } from '../src/renderer/workspace/WorkspaceSurfaceHost';
import {
    buildSandboxedPreviewDocument,
    checkAllowedImageSource,
    convertRtfToPreviewHtml,
    normalizeSafeHtmlPreview
} from '../src/renderer/workspace/WorkspaceSurfaceHelpers';
import { buildBoardDocumentModel, buildBoardDocumentPayloadSerialized } from '../src/renderer/workspace/WorkspaceBoardModel';
import { resolveSurfaceComponent } from '../src/renderer/workspace/WorkspaceSurfaceRegistry';
import { buildPdfSurfaceControls } from '../src/renderer/workspace/surfaces/PdfSurface';
import { buildImageSurfaceControls } from '../src/renderer/workspace/surfaces/ImageSurface';
import { buildHtmlSurfaceControls } from '../src/renderer/workspace/surfaces/HtmlSurface';
import { buildBoardSurfaceControls } from '../src/renderer/workspace/surfaces/BoardSurface';
import TextEditorSurface from '../src/renderer/workspace/surfaces/TextEditorSurface';
import FallbackSurface from '../src/renderer/workspace/surfaces/FallbackSurface';
import { buildSurfaceStateMetadata, getSurfaceState } from '../src/renderer/workspace/WorkspaceSurfaceState';
import type { WorkspaceDocument } from '../src/renderer/types';

describe('Workspace content type resolver', () => {
    it('maps required file extensions', () => {
        expect(resolveWorkspaceContentType({ path: 'index.html' })).toBe('html');
        expect(resolveWorkspaceContentType({ path: 'index.htm' })).toBe('html');
        expect(resolveWorkspaceContentType({ path: 'notes.rtf' })).toBe('rtf');
        expect(resolveWorkspaceContentType({ path: 'manual.pdf' })).toBe('pdf');
        expect(resolveWorkspaceContentType({ path: 'image.png' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'photo.jpg' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'photo.jpeg' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'frame.webp' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'anim.gif' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'vector.svg' })).toBe('image');
        expect(resolveWorkspaceContentType({ path: 'layout.board' })).toBe('board');
        expect(resolveWorkspaceContentType({ path: 'layout.board.json' })).toBe('board');
        expect(resolveWorkspaceContentType({ path: 'main.ts' })).toBe('text');
        expect(resolveWorkspaceContentType({ path: 'unknown.bin' })).toBe('unknown');
    });

    it('maps artifact and mime hints deterministically', () => {
        expect(resolveWorkspaceContentType({ artifactType: 'board' })).toBe('board');
        expect(resolveWorkspaceContentType({ artifactType: 'rtf' })).toBe('rtf');
        expect(resolveWorkspaceContentType({ artifactType: 'pdf' })).toBe('pdf');
        expect(resolveWorkspaceContentType({ artifactType: 'image' })).toBe('image');
        expect(resolveWorkspaceContentType({ mimeType: 'text/html; charset=utf-8' })).toBe('html');
        expect(resolveWorkspaceContentType({ mimeType: 'application/pdf' })).toBe('pdf');
        expect(resolveWorkspaceContentType({ mimeType: 'image/svg+xml' })).toBe('image');
    });
});

describe('Workspace host routing + text preservation', () => {
    it('routes text documents to text surface kind', () => {
        const doc = createWorkspaceDocumentFromFile({
            id: '1',
            title: 'app.ts',
            path: 'src/app.ts',
            payload: 'console.log(1);'
        });
        expect(doc.contentType).toBe('text');
        expect(doc.readOnly).toBe(false);
        expect(getSurfaceTypeForDocument(doc)).toBe('text');
    });

    it('routes unknown documents to fallback surface', () => {
        const unknownDoc = {
            id: '2',
            title: 'blob.bin',
            contentType: 'unknown' as const,
            dirty: false,
            readOnly: true
        };
        expect(getSurfaceTypeForDocument(unknownDoc)).toBe('unknown');
        expect(resolveSurfaceComponent('text')).toBe(TextEditorSurface);
        expect(resolveSurfaceComponent('unknown')).toBe(FallbackSurface);
    });
});

describe('Surface controls model', () => {
    it('exposes deterministic PDF controls', () => {
        const controls = buildPdfSurfaceControls({ currentPage: 2, pageCount: 5, hasDocument: true, zoom: 1.2 });
        expect(controls.find((control) => control.id === 'pdf-prev')?.disabled).toBe(false);
        expect(controls.find((control) => control.id === 'pdf-page-status')?.value).toBe('2/5');
        expect(controls.find((control) => control.id === 'pdf-zoom-status')?.value).toBe('120%');
    });

    it('exposes deterministic image/html/board controls', () => {
        const imageControls = buildImageSurfaceControls({ hasSource: true, fitToView: true, zoom: 1.4 });
        expect(imageControls.find((control) => control.id === 'image-fit')?.active).toBe(true);

        const htmlControls = buildHtmlSurfaceControls({ fitToPane: false, htmlSize: 123 });
        expect(htmlControls.find((control) => control.id === 'html-size')?.value).toBe('123 chars');

        const boardControls = buildBoardSurfaceControls({
            readOnly: false,
            canSave: true,
            showGrid: true,
            zoom: 0.9,
            elementCount: 4,
        });
        expect(boardControls.find((control) => control.id === 'board-grid')?.active).toBe(true);
        expect(boardControls.find((control) => control.id === 'board-save')?.disabled).toBe(false);
        expect(boardControls.find((control) => control.id === 'board-element-status')?.value).toBe('4');
    });
});

describe('RTF + HTML preview sanitization pipeline', () => {
    it('converts RTF and sanitizes preview content with parser-backed policy', () => {
        const html = convertRtfToPreviewHtml('{\\rtf1\\ansi\\b Bold\\b0\\par Normal\\par}');
        expect(html).toContain('<strong>');

        const sanitized = normalizeSafeHtmlPreview('<script>alert(1)</script><p onclick="x()">ok</p>');
        expect(sanitized).toContain('<p>ok</p>');
        expect(sanitized.toLowerCase()).not.toContain('<script');
        expect(sanitized.toLowerCase()).not.toContain('onclick');

        expect(normalizeSafeHtmlPreview('<iframe src="x"></iframe><p>x</p>')).toBe('<p>x</p>');
        expect(normalizeSafeHtmlPreview('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
        const objectFiltered = normalizeSafeHtmlPreview('<object>bad</object><p>safe</p>');
        expect(objectFiltered).toContain('<p>safe</p>');
        expect(objectFiltered.toLowerCase()).not.toContain('<object');

        const wrapped = buildSandboxedPreviewDocument('<p>preview</p>');
        expect(wrapped).toContain("default-src 'none'");
        expect(wrapped).toContain('<p>preview</p>');
        expect(wrapped).toContain('img-src data: blob: file:;');

        expect(checkAllowedImageSource('data:image/svg+xml,<svg></svg>')).toBe(false);
        expect(checkAllowedImageSource('data:image/png;base64,AA')).toBe(true);
        expect(checkAllowedImageSource('data:text/html,<h1>x</h1>')).toBe(false);
        expect(checkAllowedImageSource('vbscript:msgbox(1)')).toBe(false);
        expect(checkAllowedImageSource('https://example.com/a.png')).toBe(true);
        expect(checkAllowedImageSource('ftp://example.com/a.png')).toBe(false);
    });
});

describe('Board model loading, validation, and persistence', () => {
    it('loads legacy positioned elements and normalizes schema', () => {
        const doc = buildBoardDocumentModel(JSON.stringify({
            id: 'board-1',
            elements: [
                { id: 't1', type: 'text', x: 10, y: 20, w: 200, h: 80, text: 'Hello' },
                { id: 'c1', type: 'card', x: 50, y: 120, w: 240, h: 140, text: 'Card' }
            ]
        }));
        expect(doc.elements).toHaveLength(2);
        expect(doc.elements[0].position.x).toBe(10);
        expect(doc.elements[1].type).toBe('panel');
    });

    it('serializes validated board payload deterministically', () => {
        const payload = buildBoardDocumentPayloadSerialized({
            version: 1,
            id: 'board-2',
            title: 'Board',
            viewport: { zoom: 1.1, offsetX: 10, offsetY: 20 },
            elements: [
                {
                    id: 'text-1',
                    type: 'text',
                    position: { x: 12, y: 34 },
                    size: { width: 210, height: 120 },
                    text: 'Hello',
                }
            ]
        });
        const reloaded = buildBoardDocumentModel(payload);
        expect(reloaded.id).toBe('board-2');
        expect(reloaded.viewport?.zoom).toBe(1.1);
        expect(reloaded.elements[0].type).toBe('text');
    });

    it('fails safely for malformed payload', () => {
        const malformed = buildBoardDocumentModel('{"version":999,"bad":true}');
        expect(malformed.elements).toHaveLength(0);
    });
});

describe('Surface state metadata persistence helpers', () => {
    it('stores and restores per-surface state in metadata map', () => {
        const document: WorkspaceDocument = {
            id: 'doc-1',
            title: 'sample.html',
            contentType: 'html',
            dirty: false,
            readOnly: false,
        };
        const metadata = buildSurfaceStateMetadata(document, 'html', { fitToPane: true });
        const withMetadata: WorkspaceDocument = { ...document, metadata };
        const state = getSurfaceState<{ fitToPane: boolean }>(withMetadata, 'html');
        expect(state?.fitToPane).toBe(true);
    });
});
