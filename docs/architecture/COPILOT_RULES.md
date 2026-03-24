# Copilot Rules — Tala

## IPC
- No duplicate ipcMain.handle registrations
- Always removeHandler before re-registering

## Providers
- providerId must match implementation
- No endpoint alias drift

## Inference
- Streaming must produce tokens
- No blocking or silent failures

## Retrieval
- Search must return results
- Save → notebook must persist

## Local-First
- No external API required to run
- Missing API keys must degrade, not fail
