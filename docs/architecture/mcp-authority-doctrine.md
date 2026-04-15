# MCP Authority Doctrine

## Doctrine Block (Binding)

### Classification Law
- MCP host runtime is an internal Tala subsystem.
- MCP clients instantiated by Tala are internal protocol actors.
- MCP servers are external capability providers, including local processes.
- MCP protocol messages are boundary-contract traffic between Tala and external providers.

### Authority Law
Tala alone owns:
- connect/disconnect/restart/session teardown
- registration and activation decisions
- health classification
- compatibility validation
- policy approval
- routing approved capabilities into runtime
- operator-visible diagnostics

### Isolation Law
- One MCP server failure only degrades that server.
- A failing server must not poison unrelated servers or global runtime state.

### Exposure Law
- Configured is not approved.
- No tool/resource/prompt capability is exposed to runtime until Tala validation and policy approval pass.

### Transport Law
- STDIO protocol streams must not be polluted by routine stdout logs.
- Operational logging must use stderr or file sinks.

### Addition Law
- New MCP servers are added only through Tala authority registration paths.
- Direct ad hoc wiring, renderer-only injection, and untyped bypass registration are forbidden.

## Runtime Enforcement Surface
- `electron/services/mcp/McpAuthorityService.ts` is the MCP host-control authority seam.
- `electron/services/mcp/McpProviderTemplate.ts` provides canonical template builders, validation, normalization, exposure shaping, and diagnostics redaction helpers that feed authority.
- `electron/services/McpService.ts` provides governed runtime transports (`stdio`, `websocket`, `http` Streamable HTTP) consumed through authority activation.
- `ToolService.refreshMcpTools()` exposes only authority-approved MCP capabilities.
- `IpcRouter` routes MCP registration and activation through authority APIs.
- `RuntimeDiagnosticsAggregator` consumes authority inventory as canonical MCP status truth.
