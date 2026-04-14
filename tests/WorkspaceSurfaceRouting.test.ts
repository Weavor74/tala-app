import { describe, it, expect } from 'vitest';
import { resolveWorkspaceContentType } from '../src/renderer/workspace/WorkspaceContentTypeResolver';
import { createWorkspaceDocumentFromFile } from '../src/renderer/workspace/WorkspaceDocumentFactory';
import { getSurfaceTypeForDocument } from '../src/renderer/workspace/WorkspaceSurfaceHost';
import {
    buildSandboxedPreviewDocument,
    checkAllowedImageSource,
    convertRtfToPreviewHtml,
    normalizeSafeHtmlPreview
} from '../src/renderer/workspace/WorkspaceSurfaceHelpers';
import { buildBoardDocumentModel } from '../src/renderer/workspace/WorkspaceBoardModel';
import { resolveSurfaceComponent } from '../src/renderer/workspace/WorkspaceSurfaceRegistry';
import TextEditorSurface from '../src/renderer/workspace/surfaces/TextEditorSurface';
import FallbackSurface from '../src/renderer/workspace/surfaces/FallbackSurface';

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

describe('RTF preview pipeline', () => {
    it('converts and sanitizes preview content', () => {
        const html = convertRtfToPreviewHtml('{\\rtf1\\ansi\\b Bold\\b0\\par Normal\\par}');
        expect(html).toContain('<strong>');
        const sanitized = normalizeSafeHtmlPreview('<script>alert(1)</script><p>ok</p>');
        expect(sanitized).toContain('<p>ok</p>');
        expect(sanitized.toLowerCase()).not.toContain('<script');
        expect(normalizeSafeHtmlPreview('<iframe src="x"></iframe><p>x</p>')).toBe('<p>x</p>');
        const wrapped = buildSandboxedPreviewDocument('<p>preview</p>');
        expect(wrapped).toContain('Content-Security-Policy');
        expect(wrapped).toContain('<p>preview</p>');
        expect(checkAllowedImageSource('data:image/svg+xml,<svg></svg>')).toBe(false);
        expect(checkAllowedImageSource('data:image/png;base64,AA')).toBe(true);
        expect(checkAllowedImageSource('data:text/html,<h1>x</h1>')).toBe(false);
        expect(checkAllowedImageSource('vbscript:msgbox(1)')).toBe(false);
        expect(checkAllowedImageSource('https://example.com/a.png')).toBe(true);
        expect(checkAllowedImageSource('ftp://example.com/a.png')).toBe(false);
    });
});

describe('Board model loading', () => {
    it('loads positioned elements from schema', () => {
        const doc = buildBoardDocumentModel(JSON.stringify({
            id: 'board-1',
            elements: [
                { id: 't1', type: 'text', x: 10, y: 20, w: 200, h: 80, text: 'Hello' },
                { id: 'c1', type: 'card', x: 50, y: 120, w: 240, h: 140, text: 'Card' }
            ]
        }));
        expect(doc.elements).toHaveLength(2);
        expect(doc.elements[0].x).toBe(10);
        expect(doc.elements[1].type).toBe('card');
    });
});

