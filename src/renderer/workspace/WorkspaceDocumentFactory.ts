import type { WorkspaceArtifact } from '../types';
import type { WorkspaceDocument } from '../types';
import { resolveWorkspaceContentType } from './WorkspaceContentTypeResolver';

export interface CreateFileDocumentInput {
    id: string;
    title: string;
    path: string;
    payload?: string;
    readOnly?: boolean;
    metadata?: Record<string, unknown>;
}

export function createWorkspaceDocumentFromFile(input: CreateFileDocumentInput): WorkspaceDocument {
    return {
        id: input.id,
        title: input.title,
        path: input.path,
        mimeType: undefined,
        contentType: resolveWorkspaceContentType({ path: input.path }),
        dirty: false,
        readOnly: input.readOnly ?? false,
        payload: input.payload,
        sourceRef: input.path,
        metadata: input.metadata,
    };
}

export function createWorkspaceDocumentFromArtifact(artifact: WorkspaceArtifact): WorkspaceDocument {
    return {
        id: artifact.id,
        title: artifact.title || artifact.path?.split(/[/\\]/).pop() || 'Artifact',
        path: artifact.path,
        uri: artifact.url,
        mimeType: artifact.mimeType,
        contentType: resolveWorkspaceContentType({
            path: artifact.path,
            mimeType: artifact.mimeType,
            artifactType: artifact.type,
        }),
        dirty: false,
        readOnly: artifact.readOnly ?? true,
        payload: typeof artifact.content === 'string' ? artifact.content : undefined,
        sourceRef: artifact.url || artifact.path,
        metadata: artifact.metadata,
    };
}
