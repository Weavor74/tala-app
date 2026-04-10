# Phase 3 - Live Inference Path Integration

## Overview

Phase 3 integrates `LocalInferenceManager` and the provider registry into the live inference path so every request is routed through one auditable policy.

Core components:

1. `InferenceProviderRegistry` (`electron/services/inference/InferenceProviderRegistry.ts`)
2. `ProviderSelectionService` (`electron/services/inference/ProviderSelectionService.ts`)
3. `InferenceService` (`electron/services/InferenceService.ts`)
4. `AgentService.loadBrainConfig()` provider/bootstrap integration (`electron/services/AgentService.ts`)

## Provider Types

| Provider ID | Type | Scope | Transport |
|-------------|------|-------|-----------|
| `ollama` | `ollama` | local | HTTP Ollama API (`/api/tags`) |
| `vllm` | `vllm` | local | HTTP OpenAI-compatible (`/v1/models`) |
| `llamacpp` | `llamacpp` | local | HTTP OpenAI-compatible |
| `koboldcpp` | `koboldcpp` | local | HTTP KoboldCpp API |
| `embedded_vllm` | `embedded_vllm` | embedded | Managed vLLM OpenAI-compatible server |
| `embedded_llamacpp` | `embedded_llamacpp` | embedded | Managed llama.cpp OpenAI-compatible server |
| `cloud` | `cloud` | cloud | HTTP OpenAI-compatible |

## Deterministic Waterfall Policy

Implemented in `ProviderSelectionService.select()`.

Selection semantics:

1. Use request-level `preferredProviderId` when provided and ready.
2. Otherwise use registry-stored selected provider (`selectedProviderId`) when ready.
3. If preferred/stored provider is unavailable and fallback is allowed, emit `provider_fallback_applied` and continue.
4. Continue through explicit waterfall order, selecting first ready provider.
5. Fail only when waterfall is exhausted.

Waterfall order:

1. `ollama`
2. `vllm`
3. `llamacpp`
4. `koboldcpp`
5. `embedded_vllm`
6. `embedded_llamacpp`
7. `cloud`

Mode constraints:

- `auto`: local + embedded + cloud in waterfall order
- `local-only`: local + embedded only
- `cloud-only`: cloud only

Cloud is only selected in `auto` after local/embedded providers are exhausted, or directly in `cloud-only` mode.

## Embedded Authority and Startup

`InferenceService` now exposes a canonical embedded startup path:

- `ensureEmbeddedProviderStarted(...)`
  - attempts `embedded_vllm` first (authoritative embedded engine)
  - optionally falls back to legacy `embedded_llamacpp` startup

Embedded vLLM startup:

- `ensureEmbeddedVllmStarted(...)`
  - adopts an already-running OpenAI-compatible server on configured port
  - otherwise launches `scripts/run-vllm.bat` (Windows) or `scripts/run-vllm.sh` (Linux/macOS)
  - polls `/v1/models` until ready

Legacy embedded llama.cpp startup is retained via `ensureEmbeddedStarted(...)` and used only as optional fallback.

## AgentService Runtime Path

`AgentService.loadBrainConfig()` now:

1. Rebuilds registry config from settings instances.
2. Registers `embeddedVllm` and `embeddedLlamaCpp` providers.
3. Resolves preferred provider/model from settings (`activeLocalId`) into canonical provider IDs.
4. Calls `InferenceService.selectProvider(...)`.
5. If no provider is viable, calls `InferenceService.ensureEmbeddedProviderStarted(...)` (embedded vLLM first), refreshes inventory, and re-selects.
6. Binds brain by protocol:
   - `ollama` -> `OllamaBrain`
   - `vllm`, `embedded_vllm`, `llamacpp`, `embedded_llamacpp`, `cloud` -> `CloudBrain` (OpenAI-compatible)

## Telemetry and Auditability

Selection/registry/startup path emits:

- `provider_selected`
- `provider_fallback_applied`
- `provider_unavailable`
- `provider_inventory_refreshed`
- startup/failure events under `local_inference` (`inference_started`, `inference_failed`)

Every selection result carries `attemptedProviders`, `fallbackApplied`, and `executionPath`.

## Tests

Primary coverage for selection behavior is in:

- `electron/__tests__/inference/ProviderSelection.test.ts`

Coverage includes:

- request preferred provider honored
- registry selected provider honored when request preferred is omitted
- unavailable preferred provider falls through deterministically
- Ollama unavailable -> next ready provider
- embedded vLLM chosen before embedded llama.cpp when local providers are down
- cloud only after local/embedded exhaustion in auto mode
- mode-policy enforcement (`local-only`, `cloud-only`)
- fallback/unavailable telemetry emission
