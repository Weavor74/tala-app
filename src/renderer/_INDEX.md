# src/renderer/ — UI Views & Configuration

Contains the major view-level components (Settings, UserProfile, A2UIRenderer) and shared type/data definitions.

---

## Folders

| Folder | Description |
|---|---|
| `components/` | Reusable UI components — FileExplorer, GitView, Browser, Terminal, Library, Search, SourceControl, WorkflowEditor. |
| `catalog/` | Component catalog for the A2UI dynamic rendering system. |

---

## Files

| File | Size | Description |
|---|---|---|
| `Settings.tsx` | 205 KB | **Settings Panel.** The largest frontend file. Tabbed UI for configuring: LLM providers (API keys, models), MCP server connections, user rules, workflow management, function management, inference engine setup, authentication (Google/GitHub/Microsoft/Apple), and profile editing. Key functions: `handleSave()`, `handleLogin()`, `loadFunctions()`, `loadWorkflows()`. |
| `UserProfile.tsx` | 12 KB | **User Profile Editor.** Form for editing the user's deep profile (name, address, work history, schools, network contacts). Data is saved to `mem0` via IPC. Key functions: `handleSave()`, `load()`, `updateItem()`, `removeItem()`. |
| `settingsData.ts` | 14 KB | **Settings Schema.** Defines the `AppSettings` TypeScript interface and `DEFAULT_SETTINGS` constant. Contains `migrateSettings()` for backwards compatibility. |
| `A2UIRenderer.tsx` | 2 KB | **Dynamic UI Renderer.** Renders UI from JSON structures produced by the agent. Maps component type names (`button`, `card`, `text`) to React components from the catalog. Key function: `RecursiveRenderer()`. |
| `profileData.ts` | 1 KB | **Profile Schema.** Defines the `UserDeepProfile` interface and `DEFAULT_PROFILE` constant. |
| `types.ts` | 209 B | **Shared Types.** Common TypeScript type definitions used across renderer components. |
| `CAPABILITIES.md` | 579 B | **Documentation.** Lists the A2UI component types available for dynamic rendering. |
