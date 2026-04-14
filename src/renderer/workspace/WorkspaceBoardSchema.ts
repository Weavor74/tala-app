import { z } from 'zod';

export type BoardElementType = 'text' | 'panel' | 'image';

export interface BoardPoint {
    x: number;
    y: number;
}

export interface BoardSize {
    width: number;
    height: number;
}

export interface BoardElementBase {
    id: string;
    type: BoardElementType;
    position: BoardPoint;
    size: BoardSize;
    zIndex?: number;
}

export interface BoardTextElement extends BoardElementBase {
    type: 'text';
    text: string;
}

export interface BoardPanelElement extends BoardElementBase {
    type: 'panel';
    title?: string;
    text?: string;
}

export interface BoardImageElement extends BoardElementBase {
    type: 'image';
    src: string;
    alt?: string;
}

export type BoardElement = BoardTextElement | BoardPanelElement | BoardImageElement;

export interface BoardViewport {
    zoom?: number;
    offsetX?: number;
    offsetY?: number;
}

export interface BoardDocumentPayload {
    version: 1;
    id: string;
    title?: string;
    viewport?: BoardViewport;
    canvas?: {
        width?: number;
        height?: number;
        background?: string;
        showGrid?: boolean;
    };
    elements: BoardElement[];
}

const pointSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
});

const sizeSchema = z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
});

const baseElementSchema = z.object({
    id: z.string().min(1),
    position: pointSchema,
    size: sizeSchema,
    zIndex: z.number().finite().optional(),
});

const textElementSchema = baseElementSchema.extend({
    type: z.literal('text'),
    text: z.string().default(''),
});

const panelElementSchema = baseElementSchema.extend({
    type: z.literal('panel'),
    title: z.string().optional(),
    text: z.string().optional(),
});

const imageElementSchema = baseElementSchema.extend({
    type: z.literal('image'),
    src: z.string().min(1),
    alt: z.string().optional(),
});

const elementSchema = z.union([textElementSchema, panelElementSchema, imageElementSchema]);

const boardDocumentSchema = z.object({
    version: z.literal(1),
    id: z.string().min(1),
    title: z.string().optional(),
    viewport: z.object({
        zoom: z.number().finite().positive().optional(),
        offsetX: z.number().finite().optional(),
        offsetY: z.number().finite().optional(),
    }).optional(),
    canvas: z.object({
        width: z.number().finite().positive().optional(),
        height: z.number().finite().positive().optional(),
        background: z.string().optional(),
        showGrid: z.boolean().optional(),
    }).optional(),
    elements: z.array(elementSchema),
});

function mapLegacyElement(raw: any, index: number): BoardElement | null {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;
    const type = raw.type;
    const legacyX = raw.x;
    const legacyY = raw.y;
    const legacyW = raw.w;
    const legacyH = raw.h;
    if (![legacyX, legacyY, legacyW, legacyH].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;

    const base = {
        id: typeof raw.id === 'string' ? raw.id : `element-${index}`,
        position: { x: legacyX, y: legacyY },
        size: { width: legacyW, height: legacyH },
        zIndex: typeof raw.z === 'number' && Number.isFinite(raw.z) ? raw.z : index,
    };

    if (type === 'text') return { ...base, type: 'text', text: typeof raw.text === 'string' ? raw.text : '' };
    if (type === 'card') return { ...base, type: 'panel', title: 'Card', text: typeof raw.text === 'string' ? raw.text : undefined };
    if (type === 'panel') return { ...base, type: 'panel', title: typeof raw.title === 'string' ? raw.title : undefined, text: typeof raw.text === 'string' ? raw.text : undefined };
    if (type === 'image' && typeof raw.imageUri === 'string') return { ...base, type: 'image', src: raw.imageUri, alt: typeof raw.text === 'string' ? raw.text : undefined };
    if (type === 'image' && typeof raw.src === 'string') return { ...base, type: 'image', src: raw.src, alt: typeof raw.alt === 'string' ? raw.alt : undefined };
    return null;
}

function mapLegacyBoard(raw: any, title?: string): BoardDocumentPayload {
    const rawElements = Array.isArray(raw?.elements) ? raw.elements : [];
    const elements = rawElements
        .map((item: unknown, index: number) => mapLegacyElement(item, index))
        .filter(Boolean) as BoardElement[];
    return {
        version: 1,
        id: typeof raw?.id === 'string' ? raw.id : 'board',
        title: typeof raw?.title === 'string' ? raw.title : title,
        canvas: raw?.canvas && typeof raw.canvas === 'object' ? {
            width: typeof raw.canvas.width === 'number' ? raw.canvas.width : undefined,
            height: typeof raw.canvas.height === 'number' ? raw.canvas.height : undefined,
            background: typeof raw.canvas.background === 'string' ? raw.canvas.background : undefined,
            showGrid: typeof raw.canvas.showGrid === 'boolean' ? raw.canvas.showGrid : undefined,
        } : undefined,
        viewport: raw?.viewport && typeof raw.viewport === 'object' ? {
            zoom: typeof raw.viewport.zoom === 'number' ? raw.viewport.zoom : undefined,
            offsetX: typeof raw.viewport.offsetX === 'number' ? raw.viewport.offsetX : undefined,
            offsetY: typeof raw.viewport.offsetY === 'number' ? raw.viewport.offsetY : undefined,
        } : undefined,
        elements,
    };
}

export function buildBoardDocumentPayload(payload?: string, title?: string): BoardDocumentPayload {
    if (!payload) {
        return { version: 1, id: 'board', title, elements: [] };
    }
    try {
        const raw = JSON.parse(payload);
        const parsed = boardDocumentSchema.safeParse(raw);
        if (parsed.success) return parsed.data;

        const legacy = mapLegacyBoard(raw, title);
        const legacyParsed = boardDocumentSchema.safeParse(legacy);
        if (legacyParsed.success) return legacyParsed.data;

        return { version: 1, id: 'board-invalid', title, elements: [] };
    } catch {
        return { version: 1, id: 'board-invalid', title, elements: [] };
    }
}

export function buildBoardDocumentPayloadSerialized(payload: BoardDocumentPayload): string {
    const parsed = boardDocumentSchema.parse(payload);
    return JSON.stringify(parsed, null, 2);
}
