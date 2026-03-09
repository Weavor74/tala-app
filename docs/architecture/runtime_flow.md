# Runtime Flow

This document outlines the dynamic behavior of the Tala system across various operational phases.

## 1. Application Startup Sequence
The startup sequence ensures that all frontend and backend services are correctly initialized and connected.

1. **Host Launch**: `electron/main.ts` executes.
2. **Service Registry**: Core services (`AgentService`, `ToolService`, `LoggingService`) are instantiated.
3. **MCP Bootstrap**: The `ToolService` scans for configured MCP servers and launches them as sidecar Python processes.
4. **Inference Readiness**: The `scripts/launch-inference.bat` (Ollama) is verified/started.
5. **Window Initialization**: The React renderer (index.html) is loaded into the Chrome frame.
6. **Preload Attachment**: `preload.ts` attaches the secure IPC bridge to the `window` object.

## 2. Agent Turn Loop (Chat Flow)
The core "intelligence" loop follows a multi-step sequence for every user message.

1. **User Submission**: User types a message in the React UI.
2. **IPC Dispatch**: Message is sent via `tala:chat` channel to the `IpcRouter`.
3. **Agent Activation**: `AgentService.chat()` is called.
4. **Context Retrieval**:
    - `TalaCore` (MCP) retrieves relevant RAG chunks.
    - `Mem0Core` (MCP) retrieves user facts.
    - `AstroEngine` (MCP) provides an emotional vector.
5. **Prompt Construction**: `AgentService` assembles the final prompt template.
6. **LLM Inference**: `OllamaBrain` sends the prompt to the local LLM.
7. **Reasoning Analysis**:
    - If the LLM requests a tool: `ToolService` executes the tool and the loop returns to step 6.
    - If the LLM provides a response: The loop continues to step 8.
8. **Guardrail Validation**: `GuardrailService` checks the output.
9. **UI Delivery**: The final response is streamed back to the renderer via IPC.

## 3. Tool Execution Flow
Detailed flow for when an agent decides to perform an action.

1. **Tool Identification**: Agent chooses a tool (e.g., `read_file`).
2. **Call Serialization**: Tool name and arguments are passed to `ToolService.executeTool()`.
3. **Registry Lookup**: `ToolService` determines if the tool is "Native" or "MCP".
4. **Execution**:
    - **Native**: Node.js `fs` or `child_process` executes directly.
    - **MCP**: A JSON-RPC call is sent over stdin/stdout to the target Python sidecar.
5. **Response Aggregation**: Success/Error data is returned to the agent's context for the next reasoning step.
