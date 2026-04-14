import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import type { BoardDocumentModel, BoardElement } from '../WorkspaceBoardModel';
import { buildBoardDocumentModel, buildBoardDocumentPayloadSerialized } from '../WorkspaceBoardModel';
import { buildDisplayFileUrl, checkAllowedImageSource } from '../WorkspaceSurfaceHelpers';
import { buildSurfaceStateMetadata, getSurfaceState } from '../WorkspaceSurfaceState';
import type { WorkspaceSurfaceControl } from './WorkspaceSurfaceControls';

interface BoardSurfaceState {
    zoom?: number;
    showGrid?: boolean;
}

export function buildBoardSurfaceControls(state: {
    readOnly: boolean;
    canSave: boolean;
    showGrid: boolean;
    zoom: number;
    elementCount: number;
}): WorkspaceSurfaceControl[] {
    return [
        { id: 'board-zoom-out', label: 'Zoom -', kind: 'button' },
        { id: 'board-zoom-in', label: 'Zoom +', kind: 'button' },
        { id: 'board-zoom-reset', label: 'Reset Zoom', kind: 'button' },
        { id: 'board-fit', label: 'Fit Board', kind: 'button' },
        { id: 'board-grid', label: 'Grid', kind: 'toggle', active: state.showGrid },
        { id: 'board-add-text', label: 'Add Text', kind: 'button', disabled: state.readOnly },
        { id: 'board-add-panel', label: 'Add Panel', kind: 'button', disabled: state.readOnly },
        { id: 'board-save', label: 'Save', kind: 'button', disabled: state.readOnly || !state.canSave },
        { id: 'board-zoom-status', label: 'Zoom', value: `${Math.round(state.zoom * 100)}%`, kind: 'status' },
        { id: 'board-element-status', label: 'Elements', value: String(state.elementCount), kind: 'status' },
    ];
}

function getElementLeft(element: BoardElement): number {
    return element.position.x;
}

function getElementTop(element: BoardElement): number {
    return element.position.y;
}

function getElementWidth(element: BoardElement): number {
    return element.size.width;
}

function getElementHeight(element: BoardElement): number {
    return element.size.height;
}

function replaceElementPosition(elements: BoardElement[], id: string, x: number, y: number): BoardElement[] {
    return elements.map((element) => (
        element.id === id
            ? { ...element, position: { x, y } }
            : element
    ));
}

function buildNewBoardElement(type: 'text' | 'panel', count: number): BoardElement {
    const base = {
        id: `${type}-${Date.now()}-${count}`,
        position: { x: 60 + (count * 14), y: 60 + (count * 12) },
        size: { width: type === 'text' ? 220 : 260, height: type === 'text' ? 110 : 160 },
        zIndex: count + 1,
    };
    if (type === 'text') {
        return { ...base, type: 'text', text: 'New text block' };
    }
    return { ...base, type: 'panel', title: 'Panel', text: 'Panel content' };
}

export const BoardSurface: React.FC<WorkspaceSurfaceProps> = ({
    document,
    onContentChange,
    onSave,
    onSurfaceControlsChange,
    onDocumentMetadataChange,
}) => {
    const parsed = useMemo(() => buildBoardDocumentModel(document.payload, document.title), [document.payload, document.title]);
    const persistedState = getSurfaceState<BoardSurfaceState>(document, 'board');
    const [model, setModel] = useState<BoardDocumentModel>(parsed);
    const [activeElementId, setActiveElementId] = useState<string | null>(null);
    const [zoom, setZoom] = useState(typeof persistedState?.zoom === 'number' ? persistedState.zoom : (parsed.viewport?.zoom || 1));
    const [showGrid, setShowGrid] = useState(typeof persistedState?.showGrid === 'boolean' ? persistedState.showGrid : !!parsed.canvas?.showGrid);

    useEffect(() => {
        const surfaceState = getSurfaceState<BoardSurfaceState>(document, 'board');
        setModel(parsed);
        setActiveElementId(null);
        setZoom(typeof surfaceState?.zoom === 'number' ? surfaceState.zoom : (parsed.viewport?.zoom || 1));
        setShowGrid(typeof surfaceState?.showGrid === 'boolean' ? surfaceState.showGrid : !!parsed.canvas?.showGrid);
    }, [document, parsed]);

    useEffect(() => {
        onSurfaceControlsChange?.({
            controls: buildBoardSurfaceControls({
                readOnly: document.readOnly,
                canSave: !!onSave,
                showGrid,
                zoom,
                elementCount: model.elements.length,
            }),
            onControlAction: (controlId: string) => {
                if (controlId === 'board-zoom-out') setZoom((value) => Math.max(0.25, Number((value - 0.1).toFixed(2))));
                if (controlId === 'board-zoom-in') setZoom((value) => Math.min(4, Number((value + 0.1).toFixed(2))));
                if (controlId === 'board-zoom-reset') setZoom(1);
                if (controlId === 'board-fit') {
                    const boardWidth = model.canvas?.width || 1400;
                    const fitZoom = Math.min(1, Number((1100 / boardWidth).toFixed(2)));
                    setZoom(Math.max(0.25, fitZoom));
                }
                if (controlId === 'board-grid') setShowGrid((value) => !value);
                if (controlId === 'board-add-text' && !document.readOnly) {
                    setModel((previous) => ({
                        ...previous,
                        elements: [...previous.elements, buildNewBoardElement('text', previous.elements.length)],
                    }));
                }
                if (controlId === 'board-add-panel' && !document.readOnly) {
                    setModel((previous) => ({
                        ...previous,
                        elements: [...previous.elements, buildNewBoardElement('panel', previous.elements.length)],
                    }));
                }
                if (controlId === 'board-save' && onSave) onSave();
            }
        });

        return () => onSurfaceControlsChange?.(null);
    }, [document.readOnly, model.canvas?.width, model.elements.length, onSave, onSurfaceControlsChange, showGrid, zoom]);

    useEffect(() => {
        onDocumentMetadataChange?.(buildSurfaceStateMetadata(document, 'board', { zoom, showGrid }));
    }, [document, onDocumentMetadataChange, showGrid, zoom]);

    useEffect(() => {
        if (document.readOnly || !onContentChange) return;
        const serialized = buildBoardDocumentPayloadSerialized({
            ...model,
            viewport: { ...(model.viewport || {}), zoom },
            canvas: { ...(model.canvas || {}), showGrid },
        });
        if ((document.payload || '') !== serialized) {
            onContentChange(serialized);
        }
    }, [document.payload, document.readOnly, model, onContentChange, showGrid, zoom]);

    const updateElementDragPosition = (id: string, nextX: number, nextY: number) => {
        setModel((previous) => ({ ...previous, elements: replaceElementPosition(previous.elements, id, nextX, nextY) }));
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#111' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#17191d' }}>
                <div
                    style={{
                        position: 'relative',
                        width: model.canvas?.width || 1400,
                        height: model.canvas?.height || 900,
                        background: model.canvas?.background || 'linear-gradient(180deg, #1f2530, #12161d)',
                        border: '1px solid #2c3340',
                        borderRadius: 8,
                        margin: '0 auto',
                        transform: `scale(${zoom})`,
                        transformOrigin: 'top center',
                        backgroundImage: showGrid
                            ? 'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)'
                            : undefined,
                        backgroundSize: showGrid ? '24px 24px' : undefined,
                    }}
                >
                    {model.elements.map((element) => (
                        <div
                            key={element.id}
                            style={{
                                position: 'absolute',
                                left: getElementLeft(element),
                                top: getElementTop(element),
                                width: getElementWidth(element),
                                height: getElementHeight(element),
                                zIndex: element.zIndex || 1,
                                border: activeElementId === element.id ? '1px solid #4ea8ff' : '1px solid #3b4557',
                                borderRadius: 6,
                                padding: 8,
                                color: '#dce6ff',
                                background: element.type === 'panel' ? '#273244' : 'rgba(40,48,65,0.75)',
                                overflow: 'hidden',
                                cursor: document.readOnly ? 'default' : 'move',
                            }}
                            onMouseDown={(event) => {
                                if (document.readOnly) return;
                                event.preventDefault();
                                setActiveElementId(element.id);
                                const startX = event.clientX;
                                const startY = event.clientY;
                                const originX = element.position.x;
                                const originY = element.position.y;
                                const move = (nextEvent: MouseEvent) => {
                                    updateElementDragPosition(
                                        element.id,
                                        originX + (nextEvent.clientX - startX) / zoom,
                                        originY + (nextEvent.clientY - startY) / zoom
                                    );
                                };
                                const up = () => {
                                    window.removeEventListener('mousemove', move);
                                    window.removeEventListener('mouseup', up);
                                };
                                window.addEventListener('mousemove', move);
                                window.addEventListener('mouseup', up);
                            }}
                        >
                            {element.type === 'text' && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{element.text || ''}</div>}
                            {element.type === 'panel' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <strong style={{ fontSize: 12 }}>{element.title || 'Panel'}</strong>
                                    <div style={{ fontSize: 11, opacity: 0.75 }}>{element.text || 'Layout Panel'}</div>
                                </div>
                            )}
                            {element.type === 'image' && (
                                <img
                                    src={(() => {
                                        const resolved = buildDisplayFileUrl(element.src);
                                        return checkAllowedImageSource(resolved) ? resolved : '';
                                    })()}
                                    alt={element.alt || 'board-image'}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 4 }}
                                />
                            )}
                        </div>
                    ))}
                    {model.elements.length === 0 && (
                        <div style={{ color: '#8a94a8', padding: 20, fontSize: 13 }}>
                            Board has no elements yet.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BoardSurface;
