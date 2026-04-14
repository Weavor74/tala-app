# Workspace Surface Host Architecture

## Scope

This document defines the center-pane multi-surface host used by Tala's
renderer workspace.

## Supported Content Types

- `text` (editable text/code path)
- `html` (safe preview)
- `board` (layout/document board surface)
- `rtf` (preview-only)
- `pdf` (in-app viewer)
- `image` (in-app image/graphics view)
- `unknown` (safe fallback)

## Routing Model

Routing is deterministic and typed:

1. Build a `WorkspaceDocument` for the active tab/document.
2. Resolve `WorkspaceContentType` from extension/mime/artifact type.
3. `WorkspaceSurfaceHost` selects the surface component from the registry.
4. The selected surface renders inside the existing center pane shell.

No parallel workspace subsystem is introduced. Existing tabs and center pane
containment remain authoritative.

## RTF Rule

RTF support is preview-only. Tala does not provide RTF editing behavior in the
center pane.

## Board Surface (Phase 1)

The board surface uses a minimal document schema:

- `version`, `id`, optional `title`
- optional `canvas` sizing/background
- positioned `elements[]` with `x,y,w,h,z`

Phase 1 element types:

- text blocks
- basic card/panel blocks
- image blocks

The board is intentionally minimal and expandable.

## Security Handling

### HTML

- Rendered via isolated iframe with `srcDoc`.
- Sanitization removes script/style/event handlers/javascript URLs.
- No raw injection into the app DOM.

### RTF

- Converted to preview HTML.
- Sanitized before render.
- No script execution path.

### PDF

- Rendered in-app via PDF.js canvas rendering.
- No external browser handoff required.

### SVG/Image

- Rendered as image sources within the workspace surface.
- No inline script execution path is enabled in the renderer host.

