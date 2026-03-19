# Phase 3 — Live Inference Path Integration

## Overview

Phase 3 integrates `LocalInferenceManager` into the real, end-to-end inference path so every actual inference request flows through one authoritative runtime manager. It adds:

1. A canonical provider registry (`InferenceProviderRegistry`) that detects and tracks all configured inference providers.
2. A deterministic provider selection and fallback policy (`ProviderSelectionService`).
3. A unified `InferenceService` that is the single entry point for all provider management operations.
4. Structured telemetry for every provider decision, probe, selection, fallback, and failure.
5. IPC handlers that expose provider inventory to the renderer for settings UI.

---

## Files Added

| File | Purpose |
|------|---------|
| `shared/inferenceProviderTypes.ts` | Canonical type model for providers, selection, execution, and failure |
| `electron/services/inference/InferenceProviderRegistry.ts` | Provider registry with per-type probes |
| `electron/services/inference/ProviderSelectionService.ts` | Deterministic selection and fallback policy |

## Files Modified

| File | Change |
|------|--------|
| `shared/telemetry.ts` | Added provider lifecycle and stream telemetry event types |
| `electron/services/InferenceService.ts` | Integrated registry, selection, and `LocalInferenceManager` |
| `electron/services/IpcRouter.ts` | Added `inference:listProviders`, `inference:refreshProviders`, `inference:selectProvider`, `inference:getSelectedProvider` |
| `electron/services/AgentService.ts` | `loadBrainConfig()` now routes through `InferenceService.selectProvider()` |

---

## Provider Types

| Provider ID | Type | Scope | Transport |
|-------------|------|-------|-----------|
| `ollama` | `ollama` | local | HTTP Ollama API (`:11434/api/tags`) |
| `llamacpp` | `llamacpp` | local | HTTP OpenAI-compat (configurable port) |
| `embedded_llamacpp` | `embedded_llamacpp` | embedded | HTTP OpenAI-compat (`:8080/health`) + fs availability check |
| `vllm` | `vllm` | local | HTTP OpenAI-compat (configurable port) |
| `koboldcpp` | `koboldcpp` | local | HTTP KoboldCpp API (`:5001/api/v1/model`) |
| `cloud` | `cloud` | cloud | HTTP OpenAI-compat (configurable endpoint) |

---

## Selection Policy

Selection applies in this exact order. No silent cloud preference when local is available.

1. **User-selected provider** — if `preferredProviderId` is set and that provider is `ready`.
2. **Fallback applied** (emit `provider_fallback_applied` telemetry) — if preferred is not ready.
3. **Best available local provider** — filtered by scope `'local'`, sorted by `priority` (ascending).
4. **Embedded llama.cpp** — scope `'embedded'`, if `ready`.
5. **Cloud provider** — scope `'cloud'`, if `ready`.
6. **Explicit failure** — returns `InferenceSelectionResult { success: false, failure: InferenceFailureResult }`.

Mode overrides:
- `local-only` — stops at step 4, does not fall through to cloud.
- `cloud-only` — jumps directly to step 5.

---

## InferenceProviderDescriptor Model

```ts
interface InferenceProviderDescriptor {
  providerId: string;           // Stable ID used for selection
  displayName: string;          // UI display name
  providerType: InferenceProviderType;
  scope: 'local' | 'embedded' | 'cloud';
  transport: InferenceTransportType;
  endpoint: string;             // Base HTTP URL
  configured: boolean;          // Set by registry config
  detected: boolean;            // Updated by probe
  ready: boolean;               // true when status === 'ready'
  health: InferenceProviderHealth;
  status: InferenceProviderStatus;
  priority: number;             // Lower = higher priority
  capabilities: InferenceProviderCapabilities;
  models: string[];             // Discovered model list
  preferredModel?: string;
  apiKey?: string;              // Cloud providers only
  lastProbed?: string;          // ISO timestamp
  lastProbeError?: string;
}
```

---

## AgentService Integration

`AgentService.loadBrainConfig()` was refactored to:

1. Build a `ProviderRegistryConfig` from the current settings `inference.instances` array.
2. **Always** register the embedded llama.cpp provider via `embeddedLlamaCpp` config, resolved from `localEngine.modelPath` or by scanning the `models/` directory.
3. Call `InferenceService.reconfigureRegistry(config)` to update provider descriptors.
4. Call `InferenceService.setSelectedProvider(preferredProviderId)` if a user preference exists.
5. Call `InferenceService.selectProvider({ preferredProviderId, mode, fallbackAllowed })` to obtain a canonical `InferenceSelectionResult`.
6. **If no viable provider is found**, call `InferenceService.ensureEmbeddedStarted(modelPath)` to start the Python-based embedded llama.cpp server, then re-probe and re-select.
7. Configure the active brain from the selected provider:
   - `ollama` → `OllamaBrain` (Ollama `/api/chat` protocol)
   - `embedded_llamacpp` → `CloudBrain` (OpenAI-compatible `/v1/chat/completions`)
   - `cloud` / all others → `CloudBrain` (OpenAI-compatible endpoint)

**Important brain-binding rule:** `embedded_llamacpp` must use `CloudBrain`, not `OllamaBrain`. The embedded server exposes the OpenAI-compatible API at `/v1/chat/completions`. `OllamaBrain` targets the Ollama-specific `/api/chat` endpoint and will fail silently on an embedded server.

The previous inline ad-hoc Ollama ping and llamacpp fallback logic has been removed. All fallback decisions are now auditable through the selection result's `attemptedProviders` and `fallbackApplied` fields.

---

## Embedded Provider — Guaranteed Local Baseline

The embedded llama.cpp is not merely an emergency fallback. It is the **guaranteed local baseline** when no external local engine is present:

- `probeEmbeddedLlamaCpp()` performs an **HTTP `/health` check first**, before checking binary or model file existence. This detects servers started via the Python venv (`local-inference/venv/Scripts/python.exe -m llama_cpp.server`) even when no native binary is tracked.
- `InferenceService.ensureEmbeddedStarted(modelPath, options)` starts the Python-based server if it is not running, then polls `/health` until ready or timeout (default 60 s).
- `InferenceService.resolveLocalInferencePython(repoRoot)` resolves the Python interpreter in priority order: `local-inference/venv`, project `venv`, bundled `bin/python-*`.
- Auto-start fires whenever the canonical selection yields no viable provider — **even if internet or remote providers are also available**.

---

## Backward Compatibility

- `InferenceService.getLocalEngine()` still returns `LocalEngineService` for existing IPC handlers.
- `InferenceService.scanLocal()` is preserved as a legacy method (marked `@deprecated`) for existing callers.
- `InferenceService.getLocalInferenceManager()` exposes `LocalInferenceManager` for IPC handlers that manage the embedded engine lifecycle.
- All existing IPC channel names (`local-engine-start`, `local-engine-stop`, etc.) are unchanged.

---

## Tests Added

| File | Tests | Coverage |
|------|-------|---------|
| `electron/__tests__/inference/ProviderDetection.test.ts` | 14 | Ollama healthy/unhealthy, embedded llama.cpp present/absent/running, vLLM healthy/unhealthy, KoboldCpp unavailable, registry resilience, telemetry emission |
| `electron/__tests__/inference/ProviderSelection.test.ts` | 15 | Explicit selection ready/unavailable, no-selection local/embedded/cloud fallback, no-provider failure, local-only/cloud-only modes, telemetry emission |

---

## Known Limitations

- Provider probes do not run automatically at startup — `InferenceService.refreshProviders()` must be called explicitly (e.g., from bootstrap or on settings open).
- `AgentService.loadBrainConfig()` uses the registry's last-known status for selection, not a fresh probe. It calls `refreshProviders()` internally before selection.
- The embedded llama.cpp auto-start only fires during `loadBrainConfig()`. Runtime recovery after a crash is handled by `ensureEmbeddedStarted()` called through IPC or diagnostics flows.

> **Phase 1B Update:** Streaming telemetry (`stream_opened`, `stream_completed`, `stream_aborted`) and inference reflection signals are now fully wired. See `docs/architecture/phase1b_streaming_hardening.md` for the canonical streaming path documentation.
