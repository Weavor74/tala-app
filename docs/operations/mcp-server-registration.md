# MCP Server Registration (Operator Guide)

## What MCP Means In Tala
- MCP servers are external capability providers.
- Tala is the host authority that decides registration, activation, approval, and exposure.

## Why Configured Is Not Approved
- A server can be configured but still blocked or degraded.
- Tala requires registration validation, handshake, compatibility checks, capability validation, and policy approval before activation.

## Governed Add Path
1. Register with `mcp:registerServer` (typed payload).
2. Tala validates deterministic ID, transport requirements, duplicates, and malformed entries.
3. Registration persists through Tala settings authority path.
4. Activation is separate: call `mcp:activateServer`.
5. Only approved active capabilities appear in tool/runtime surfaces.
6. Every registration/activation phase emits a typed outcome (`McpOnboardingPhaseOutcome`).

## Provider Template Examples

### STDIO Template
```ts
createStdioMcpProviderTemplate({
  displayName: 'Filesystem MCP',
  command: 'python',
  args: ['mcp_server.py'],
  env: { MCP_MODE: 'prod' },
  capabilityPolicy: { allowedFeatureIds: ['read_file', 'list_dir'] },
});
```

### HTTP Template
```ts
createHttpMcpProviderTemplate({
  displayName: 'Remote MCP',
  baseUrl: 'https://mcp.example.com',
  timeoutMs: 10000,
  healthEndpoint: '/health',
  headers: { authorization: 'Bearer ${TOKEN_REF}' },
});
```

Both templates must be submitted through `mcp:registerServer` and activated by authority. Template helpers reduce drift but never bypass policy or lifecycle gates.

## Diagnosing Degraded States
- Use `diagnostics:getMcpStatus` or `mcp:getRegistrySnapshot`.
- Inspect per-server classification and stable reason codes such as:
  - `mcp_unreachable`
  - `mcp_auth_failed`
  - `mcp_protocol_mismatch`
  - `mcp_capability_invalid`
  - `mcp_capability_quarantined`
  - `mcp_policy_blocked`
  - `mcp_stdio_stream_corrupted`
  - `mcp_registration_conflict`
  - `mcp_transport_invalid`

## STDIO Safety Rule
- MCP stdio protocol uses stdout for framed protocol traffic.
- Logging to stdout from stdio servers can corrupt protocol streams.
- Route operational logs to stderr or file sinks only.
