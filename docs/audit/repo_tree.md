# Tala Repository Tree

```text
tala-app/
├── .agent/                 # Agent workflows and functions
├── .tala/                  # App settings
├── archive/                # Legacy artifacts
├── bin/                    # Binaries and bundled Python
│   ├── python/             # Python 3.11 (minimal)
│   └── python-win/         # Python 3.13 (full distribution)
├── data/                   # User data and settings
├── docs/                   # Documentation and audit (current output)
│   └── audit/
├── electron/               # Electron main process source
│   ├── services/           # Backend logic (Reflection, etc.)
│   └── __tests__/          # Main process tests
├── local-inference/        # Local model runner (Python)
├── mcp-servers/            # MCP implementations (Python)
│   ├── astro-engine/
│   ├── mem0-core/
│   ├── tala-core/
│   └── tala-memory-graph/
├── memory/                 # Roleplay and long-term memory data
├── models/                 # LLM weights
├── patches/                # Dependency patches
├── public/                 # Static assets
├── REFLECTION_SYSTEM/      # Reflection logic
├── scripts/                # Build and maintenance scripts
├── src/                    # React renderer source
│   ├── components/         # UI components
│   └── renderer/           # Types and shared logic
├── tests/                  # Project-wide tests
└── tools/                  # Internal dev tools
```
