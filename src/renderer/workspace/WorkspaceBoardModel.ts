export type BoardElementType = 'text' | 'card' | 'image';

export interface BoardElement {
    id: string;
    type: BoardElementType;
    x: number;
    y: number;
    w: number;
    h: number;
    z?: number;
    text?: string;
    imageUri?: string;
    style?: Record<string, string | number>;
}

export interface BoardDocumentModel {
    version: 1;
    id: string;
    title?: string;
    canvas?: {
        width?: number;
        height?: number;
        background?: string;
    };
    elements: BoardElement[];
}

function checkFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function buildBoardElement(raw: any, index: number): BoardElement | null {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;
    if (!['text', 'card', 'image'].includes(raw.type)) return null;
    if (!checkFiniteNumber(raw.x) || !checkFiniteNumber(raw.y) || !checkFiniteNumber(raw.w) || !checkFiniteNumber(raw.h)) return null;

    return {
        id: typeof raw.id === 'string' ? raw.id : `element-${index}`,
        type: raw.type,
        x: raw.x,
        y: raw.y,
        w: raw.w,
        h: raw.h,
        z: checkFiniteNumber(raw.z) ? raw.z : index,
        text: typeof raw.text === 'string' ? raw.text : undefined,
        imageUri: typeof raw.imageUri === 'string' ? raw.imageUri : undefined,
        style: raw.style && typeof raw.style === 'object' ? raw.style : undefined,
    };
}

export function buildBoardDocumentModel(payload?: string, title?: string): BoardDocumentModel {
    if (!payload) {
        return {
            version: 1,
            id: 'board-empty',
            title: title || 'Board',
            elements: [],
        };
    }

    try {
        const raw = JSON.parse(payload);
        const elements = Array.isArray(raw.elements)
            ? raw.elements.map((el: any, idx: number) => buildBoardElement(el, idx)).filter(Boolean) as BoardElement[]
            : [];

        return {
            version: 1,
            id: typeof raw.id === 'string' ? raw.id : 'board',
            title: typeof raw.title === 'string' ? raw.title : title,
            canvas: raw.canvas && typeof raw.canvas === 'object' ? raw.canvas : undefined,
            elements,
        };
    } catch {
        return {
            version: 1,
            id: 'board-invalid',
            title: title || 'Board',
            elements: [],
        };
    }
}
