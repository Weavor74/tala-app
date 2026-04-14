import type React from 'react';
import type { WorkspaceContentType } from '../types';
import type { WorkspaceSurfaceProps } from './surfaces/WorkspaceSurfaceTypes';
import TextEditorSurface from './surfaces/TextEditorSurface';
import HtmlSurface from './surfaces/HtmlSurface';
import BoardSurface from './surfaces/BoardSurface';
import RtfSurface from './surfaces/RtfSurface';
import PdfSurface from './surfaces/PdfSurface';
import ImageSurface from './surfaces/ImageSurface';
import FallbackSurface from './surfaces/FallbackSurface';

export type SurfaceComponent = React.FC<WorkspaceSurfaceProps>;

export const workspaceSurfaceRegistry: Record<WorkspaceContentType, SurfaceComponent> = {
    text: TextEditorSurface,
    html: HtmlSurface,
    board: BoardSurface,
    rtf: RtfSurface,
    pdf: PdfSurface,
    image: ImageSurface,
    unknown: FallbackSurface,
};

export function resolveSurfaceComponent(type: WorkspaceContentType): SurfaceComponent {
    return workspaceSurfaceRegistry[type] || FallbackSurface;
}
