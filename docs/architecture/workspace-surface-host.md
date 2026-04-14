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

## Surface Controls

`WorkspaceSurfaceHost` now includes a typed controls outlet. Surfaces can
register controls through `WorkspaceSurfaceControlsModel` with deterministic
control IDs and action handlers.

Current controls:

- `pdf`: prev/next page, zoom in/out/reset, fit width, page/zoom status
- `image`: zoom in/out/reset, fit toggle, zoom status
- `html`: reload, fit-content toggle, preview size status
- `board`: zoom controls, fit board, grid toggle, add text/panel, save, status

Text/fallback surfaces do not expose custom controls.

## RTF Rule

RTF support is preview-only. Tala does not provide RTF editing behavior in the
center pane.

## Board Surface (Phase 1)

The board surface now uses a typed, versioned payload schema:

- `version: 1`, `id`, optional `title`
- optional `viewport` (`zoom`, `offsetX`, `offsetY`)
- optional `canvas` (`width`, `height`, `background`, `showGrid`)
- `elements[]` with discriminated union types (`text`, `panel`, `image`)
  and positioned geometry (`position`, `size`, optional `zIndex`)

Phase 1 element types:

- text blocks
- basic panel blocks
- image blocks

The board is intentionally minimal and expandable.

Board persistence path:

1. Opened board payload is parsed + validated.
2. In-surface edits update in-memory model and call host `onContentChange`.
3. File-tab save uses the existing Tala save flow (`handleSaveFile` path).
4. Session restore rehydrates board file payload from disk and restores
   per-surface metadata state from tab session metadata.

## Security Handling

### HTML

- Rendered via isolated iframe with `srcDoc`.
- Sanitization is parser-backed (`sanitize-html`) with explicit allowlists.
- No raw injection into the app DOM.

### RTF

- Converted to preview HTML.
- Sanitized through the same parser-backed preview sanitizer as HTML.
- No script execution path.

### PDF

- Rendered in-app via PDF.js canvas rendering.
- No external browser handoff required.

### SVG/Image

- Rendered as image sources within the workspace surface.
- URL policy blocks unsafe schemes and `data:image/svg+xml` payloads.
