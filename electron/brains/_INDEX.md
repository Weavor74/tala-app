# electron/brains/ — LLM Provider Adapters

This folder contains the abstraction layer for Large Language Model providers. The `IBrain` interface defines the contract; concrete implementations handle the API specifics.

---

## Files

| File | Size | Description |
|---|---|---|
| `IBrain.ts` | 1 KB | **Interface Definition.** Defines the `IBrain` interface: `chat(messages, onToken)`, `generate(prompt)`, and `getModels()`. All brain adapters must implement this. |
| `OllamaBrain.ts` | 4 KB | **Local LLM Adapter.** Implements `IBrain` for Ollama, Llama.cpp, and LM Studio endpoints. Handles streaming via chunked HTTP responses. |
| `CloudBrain.ts` | 6 KB | **Cloud LLM Adapter.** Implements `IBrain` for OpenAI, Anthropic (Claude), Google Gemini, and other OpenAI-compatible APIs. Supports tool/function calling and streaming. |
