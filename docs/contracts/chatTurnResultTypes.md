# Contract: chatTurnResultTypes.ts

**Source**: [shared\chatTurnResultTypes.ts](../../shared/chatTurnResultTypes.ts)

## Interfaces

### `ChatTurnAssistantResponse`
```typescript
interface ChatTurnAssistantResponse {
    kind: 'assistant_response';
    message: {
        content: string;
        artifactId?: string;
        outputChannel?: 'chat' | 'workspace' | 'browser' | 'diff' | 'fallback';
    }
```

### `ChatTurnFailure`
```typescript
interface ChatTurnFailure {
    kind: 'turn_failure';
    errorCode: string;
    message: string;
    source: ChatTurnResultSource;
}
```

### `ChatTurnResultSource`
```typescript
type ChatTurnResultSource = 
    | 'self_knowledge'
    | 'self_inspection'
    | 'router'
    | 'tool_first'
    | 'other';
```

### `ChatTurnResult`
```typescript
type ChatTurnResult =  ChatTurnAssistantResponse | ChatTurnFailure;
```

