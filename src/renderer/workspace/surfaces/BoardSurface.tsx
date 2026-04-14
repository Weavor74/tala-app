import React, { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';
import { buildBoardDocumentModel } from '../WorkspaceBoardModel';
import { buildDisplayFileUrl, checkAllowedImageSource } from '../WorkspaceSurfaceHelpers';

export const BoardSurface: React.FC<WorkspaceSurfaceProps> = ({ document }) => {
    const parsed = useMemo(() => buildBoardDocumentModel(document.payload, document.title), [document.payload, document.title]);
    const [elements, setElements] = useState(parsed.elements);
    const [activeElementId, setActiveElementId] = useState<string | null>(null);

    useEffect(() => {
        setElements(parsed.elements);
        setActiveElementId(null);
    }, [parsed]);

    const updateElementDragPosition = (id: string, nextX: number, nextY: number) => {
        setElements(prev => prev.map(el => (el.id === id ? { ...el, x: nextX, y: nextY } : el)));
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#111' }}>
            <div style={{ padding: '8px 12px', background: '#252526', color: '#ccc', borderBottom: '1px solid #333', fontSize: 12 }}>
                Board Surface: {parsed.title || document.title}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#17191d' }}>
                <div
                    style={{
                        position: 'relative',
                        width: parsed.canvas?.width || 1400,
                        height: parsed.canvas?.height || 900,
                        background: parsed.canvas?.background || 'linear-gradient(180deg, #1f2530, #12161d)',
                        border: '1px solid #2c3340',
                        borderRadius: 8,
                        margin: '0 auto',
                    }}
                >
                    {elements.map(el => (
                        <div
                            key={el.id}
                            style={{
                                position: 'absolute',
                                left: el.x,
                                top: el.y,
                                width: el.w,
                                height: el.h,
                                zIndex: el.z || 1,
                                border: activeElementId === el.id ? '1px solid #4ea8ff' : '1px solid #3b4557',
                                borderRadius: 6,
                                padding: 8,
                                color: '#dce6ff',
                                background: el.type === 'card' ? '#273244' : 'rgba(40,48,65,0.75)',
                                overflow: 'hidden',
                                cursor: 'move',
                                ...el.style,
                            }}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                setActiveElementId(el.id);
                                const startX = e.clientX;
                                const startY = e.clientY;
                                const originX = el.x;
                                const originY = el.y;
                                const move = (ev: MouseEvent) => updateElementDragPosition(el.id, originX + (ev.clientX - startX), originY + (ev.clientY - startY));
                                const up = () => {
                                    window.removeEventListener('mousemove', move);
                                    window.removeEventListener('mouseup', up);
                                };
                                window.addEventListener('mousemove', move);
                                window.addEventListener('mouseup', up);
                            }}
                        >
                            {el.type === 'text' && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{el.text || ''}</div>}
                            {el.type === 'card' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <strong style={{ fontSize: 12 }}>{el.text || 'Card'}</strong>
                                    <div style={{ fontSize: 11, opacity: 0.75 }}>Layout Panel</div>
                                </div>
                            )}
                            {el.type === 'image' && el.imageUri && (
                                <img
                                    src={(() => {
                                        const resolved = buildDisplayFileUrl(el.imageUri);
                                        return checkAllowedImageSource(resolved) ? resolved : '';
                                    })()}
                                    alt={el.text || 'board-image'}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 4 }}
                                />
                            )}
                        </div>
                    ))}
                    {elements.length === 0 && (
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
