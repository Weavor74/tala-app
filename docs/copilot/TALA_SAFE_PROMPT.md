# Tala Safe Copilot Prompt Template

## Critical Rules
- Preserve existing behavior
- Protect cross-file invariants
- Never introduce duplicate IPC handlers
- Never remap providers incorrectly
- Never break inference streaming
- Always validate against runtime logs

## Preserve Loop
1. Snapshot current behavior
2. Identify minimal change
3. Apply surgical fix
4. Validate invariants across files
5. Simulate runtime behavior
