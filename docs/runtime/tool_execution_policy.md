# Tool Execution Policy

## Canonical Coding Tool Set

For **coding** intent, ONLY these four tools are exposed to the model:

| Tool | Purpose |
|---|---|
| `fs_read_text` | Read a file (≤2MB) |
| `fs_write_text` | Write/overwrite a file |
| `fs_list` | List directory contents |
| `shell_run` | Run a single atomic shell command |

Legacy tools (`write_file`, `read_file`, `list_files`, `delete_file`, `create_directory`, `patch_file`, `move_file`, `copy_file`, `terminal_run`, `execute_command`, `execute_script`) are registered internally but blocked at runtime by two independent gates.

---

## Gate #1 — AgentService Pre-Execution Gate

In `AgentService.chat()`:

1. `filteredTools = tools.getToolDefinitions(toolCategory)` — computed **once** before the retry loop.
2. `allowedToolNames = new Set(filteredTools.map(t => t.function.name))` — frozen for entire turn.
3. Before calling `executeTool`, every tool call name is checked against `allowedToolNames`:
   ```
   [AgentService] rejected tool not allowed this turn: <name> allowed=[...]
   ```
4. Rejected calls push a synthetic error tool result; execution continues with remaining calls.

**Retry invariant**: `filteredTools` and `allowedToolNames` are never re-computed or re-expanded during envelope/retry paths.

---

## Gate #2 — ToolService Executor Gate

In `ToolService.executeTool(name, args, allowedNames?)`:

1. Provider prefix is stripped first (`default_api:` removed).
2. **Gate #2** (turn-scoped): If `allowedNames` is provided and `name ∉ allowedNames`:
   ```
   ToolNotAllowedThisTurn: <name>
   ```
   This fires **before** any registry lookup — no registered tool can execute outside the allowed set.
3. **Gate #1** (static): If `name ∈ LEGACY_TOOLS`, returns a string error (not throw) for backward compat.

`AgentService` always passes `allowedToolNames` as the `allowedNames` argument, giving double-layer enforcement.

---

## Envelope Mode Validation

When parsing `tool_calls` from a JSON envelope response, these checks run before any execution:

- `tool_calls.length ≤ 8` (MAX_TOOL_CALLS_PER_TURN) → HardFail
- Each `tc.name` must be `string ∈ allowedToolNames` → HardFail
- Each `tc.arguments` must be an object (not null/array) → HardFail
- `JSON.stringify(tc.arguments).length < 32768` (32KB) → HardFail

---

## Terminal Write vs. Shell Execution

| Path | Policy Checked? | Purpose |
|---|---|---|
| `TerminalService.write(id, data)` | **NO** | Pure PTY stdin relay — ESC sequences, arrows, user keystrokes |
| `CodeControlService.shellRun(command)` | **YES** | Agent-initiated commands only |

`TerminalService.write()` is a pass-through: `if (data == null) return; shell.write(data)`.  
No `isAllowed()`, no normalization, no policy checks, no empty-string guards.

---

## Shell Safety (CodeAccessPolicy.validateCommand)

Order of checks:

1. **Chain operator block** (first): `/[&|;<>]/` → rejected. Only atomic commands.
2. **Dangerous pattern block**: `rm -rf /`, `format`, `wget`, `curl`, `ssh`, `powershell`, `cmd /c`, etc.
3. **Prefix allowlist**: `npm`, `node`, `npx`, `python`, `pip`, `git`, `tsc`, `eslint`, `vitest`, `pytest`, `ls`, `dir`, `cd`, `mkdir`, `echo`, `type`, `cat`, `grep`, `find`, `.\\scripts\\`.

Timeout: `shell_run` → 60 s.

---

## TypeScript Script Execution

Always use:
```
npx tsx scripts/<name>.ts
```
**Never** `node scripts/*.ts` — Node.js does not natively run TypeScript.

---

## Verification Scripts

```
npx tsx scripts/health_probe.ts       # App info, src file count, lint exit code
npx tsx scripts/verify_tool_gates.ts  # 8-test gate verification (exit 0 = all pass)
npx tsx scripts/verify_tools_only_render.ts  # 10-case envelope + suppression tests
```

---

## Tools-Only Rendering Rule

For **coding intent** turns where `tool_calls` are emitted (native or via envelope):

- `assistantMsg.content` is forced to `""` before being pushed to `transientMessages`.
- The model's prose **never reaches the UI** for coding turns with tool calls.
- Tool outputs are still shown normally.

### Envelope Extraction

`extractJsonObjectEnvelope(text)` uses a brace-depth counter (string-literal aware) to find the first JSON object with a top-level `tool_calls` array, even when surrounded by prose. It is tolerant of:
- Prose before and/or after the JSON object
- Nested JSON objects/arrays inside arguments
- Multiple JSON objects in the same response (picks the one with `tool_calls`)
- Escaped quote sequences inside string values

### Strict Mode Logging

When `toolCategory === 'coding'` and a `tool_calls` JSON envelope is parsed, the runtime checks whether non-whitespace text exists outside the extracted JSON object. If so, it logs:
```
[AgentService] toolsOnlyStrict violation: non-json output suppressed (len=N)
```
This is informational only — the prose is suppressed, not hard-failed.
