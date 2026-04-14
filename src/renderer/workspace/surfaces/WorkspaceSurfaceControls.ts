export type WorkspaceSurfaceControlKind = 'button' | 'toggle' | 'status';

export interface WorkspaceSurfaceControl {
    id: string;
    label: string;
    kind: WorkspaceSurfaceControlKind;
    disabled?: boolean;
    active?: boolean;
    value?: string;
    title?: string;
}

export interface WorkspaceSurfaceControlsModel {
    controls: WorkspaceSurfaceControl[];
    onControlAction: (controlId: string) => void;
}

