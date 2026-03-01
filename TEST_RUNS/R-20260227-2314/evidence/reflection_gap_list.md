# Tala Capability Gap Scan — R-20260227-2314

Based on the audit of the current repository structure and tool inventory, the following 10 capabilities are identified as missing or weak:

1. **Local Audio Processing (In/Out)**
   - **Weakness**: `VoiceService` appears to rely primarily on remote APIs (OpenAI/ElevenLabs).
   - **Concrete Step**: Implement a local MCP server wrapping Whisper (for STT) and Piper (for TTS) to ensure privacy-first operation.

2. **Advanced Git Workflow Management**
   - **Weakness**: `GitService.ts` handles basic commits/push but lacks complex branching, merging, and conflict resolution.
   - **Concrete Step**: Add `create_branch`, `merge_branch`, and `resolve_conflicts` tools to the `GitService`.

3. **Real-time System Telemetry**
   - **Weakness**: `SystemService.ts` provides a static snapshot of environment variables and paths only.
   - **Concrete Step**: Implement a telemetry MCP that streams CPU/RAM usage and thermal data via WebSocket to the `A2UI`.

4. **Hierarchical Multi-Agent Orchestration**
   - **Weakness**: `OrchestratorService.ts` is minimal and lacks sophisticated sub-agent role definition.
   - **Concrete Step**: Implement a "Leader-Worker" pattern where a primary agent delegates sub-tasks to specialized "Crews" defined in the `_agents/` directory.

5. **Cloud Infrastructure Management (IaC)**
   - **Weakness**: System lacks tools for managing external cloud resources (AWS/GCP/Azure).
   - **Concrete Step**: Create a Terraform-based MCP server that allows Tala to provision and manage cloud instances for heavy computing.

6. **On-Device Model Fine-Tuning**
   - **Weakness**: Tala cannot update or refine her own weights based on user feedback.
   - **Concrete Step**: Add a `train_adapter` tool to the local inference backend using Unsloth or Peft for rapid LoRA fine-tuning on local chat history.

7. **Visual Grounding in Browser Automation**
   - **Weakness**: Current browser tools use DOM selectors; no robust visual/OCR-based interaction for non-standard UIs.
   - **Concrete Step**: Integrate a Vision-Language Model (VLM) like Moondream to provide coordinate-based interaction in the `BrowserService`.

8. **Automated Test Suite Generation**
   - **Weakness**: No automated process for generating and running regression tests for new features.
   - **Concrete Step**: Develop a `write_test` tool that uses the `GuardrailService` to enforce strict formatting for Vitest/Jest suites.

9. **Static Security Analysis & Vulnerability Scanning**
   - **Weakness**: `Guardrails` are primarily runtime-based; no preventative static analysis of the workspace.
   - **Concrete Step**: Add a `security_scan` tool that runs `bandit` (Python) and `eslint-plugin-security` (JS) on the project.

10. **Native Desktop Integration (Widgets/Tray)**
    - **Weakness**: UI is confined to a single Electron window; no background presence or OS-level notifications.
    - **Concrete Step**: Implement Electron `Notification` and `Tray` API wrappers in the `SystemService` to allow persistent status alerts.
