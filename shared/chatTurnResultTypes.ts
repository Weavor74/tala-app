export type ChatTurnResultSource =
    | 'self_knowledge'
    | 'self_inspection'
    | 'router'
    | 'tool_first'
    | 'other';

export interface ChatTurnAssistantResponse {
    kind: 'assistant_response';
    message: {
        content: string;
        artifactId?: string;
        outputChannel?: 'chat' | 'workspace' | 'browser' | 'diff' | 'fallback';
    };
    source: ChatTurnResultSource;
}

export interface ChatTurnFailure {
    kind: 'turn_failure';
    errorCode: string;
    message: string;
    source: ChatTurnResultSource;
}

export type ChatTurnResult = ChatTurnAssistantResponse | ChatTurnFailure;

