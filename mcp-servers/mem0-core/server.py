import sys
import os
import json
import io
import contextlib

@contextlib.contextmanager
def _stderr_stdout():
    """Temporarily redirect sys.stdout to sys.stderr inside a tool handler.

    mem0 (and the libraries it calls) can print progress lines to stdout during
    search/add operations.  Because MCP uses stdout as its JSON transport, any
    stray text corrupts the stream.  Wrapping each tool body with this context
    manager guarantees that rogue prints are silently diverted to stderr while
    the MCP framework still owns the real stdout file descriptor.
    """
    _prev = sys.stdout
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = _prev

# === CRITICAL: Redirect stdout to stderr BEFORE importing any third-party libs. ===
_real_stdout = sys.stdout
sys.stdout = sys.stderr

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    sys.stderr.write("[mem0-core] CRITICAL: 'mcp' library not found. Install with 'pip install mcp'.\n")
    sys.exit(1)

# Import provider resolution.  This module reads the Tala-injected config and
# NEVER probes inference endpoints directly.
from provider_resolver import (
    load_tala_runtime_config,
    build_mem0_config_from_resolution,
)

# Initialize FastMCP Server
mcp = FastMCP("mem0-core")

# --- Load Tala-injected memory runtime config ---
# Tala resolves providers before launching mem0-core and writes a
# MemoryRuntimeResolution JSON file whose path is in TALA_MEMORY_RUNTIME_CONFIG_PATH.
_tala_resolution = load_tala_runtime_config()

if _tala_resolution is not None:
    _mode = _tala_resolution.get("mode", "canonical_only")
    _mem0_config = build_mem0_config_from_resolution(_tala_resolution)
    sys.stderr.write(f"[mem0-core] READY mode={_mode} extraction={_tala_resolution.get('extraction', {}).get('providerType', 'none')} embeddings={_tala_resolution.get('embeddings', {}).get('providerType', 'none')}\n")
else:
    _mode = "canonical_only"
    _mem0_config = None
    sys.stderr.write("[mem0-core] READY mode=canonical_only extraction=none embeddings=none\n")

# Ensure storage directory exists
os.environ["MEM0_DIR"] = os.path.join(os.getcwd(), "data", "mem0_storage")
if not os.path.exists(os.environ["MEM0_DIR"]):
    os.makedirs(os.environ["MEM0_DIR"], exist_ok=True)

# Global memory instance (initialized on first use)
_memory_instance = None

def get_memory():
    """Late-loading wrapper for Mem0 Memory."""
    global _memory_instance
    if _memory_instance is None:
        if _mem0_config is None:
            # Degraded mode — no provider available.
            return None
        try:
            sys.stderr.write("[mem0-core] Late-loading Mem0 library and initializing DB...\n")
            from mem0 import Memory
            _memory_instance = Memory.from_config(_mem0_config)
            sys.stderr.write("[mem0-core] Memory initialized successfully.\n")
        except ImportError:
            sys.stderr.write("[mem0-core] ERROR: 'mem0ai' library not found. Running in degraded mode.\n")
            return None
        except BaseException as e:
            # Catch BaseException (including SystemExit) because some embedding providers
            # call sys.exit(1) on import failure rather than raising a normal Exception.
            # Letting SystemExit propagate crashes the MCP stdio server process; catching
            # it here keeps the server alive in degraded mode.
            sys.stderr.write(f"[mem0-core] ERROR: Failed to initialize Memory (degraded): {type(e).__name__}: {e}\n")
            return None
    return _memory_instance

# --- MANDATORY TOOLS (Registered at startup) ---

@mcp.tool()
def ping() -> str:
    """Standard health check."""
    return "ok"

@mcp.tool()
def version() -> str:
    """Returns the package version."""
    return "1.0.2"

@mcp.tool()
def status() -> str:
    """Returns the current internal status (no PII)."""
    extraction = (_tala_resolution or {}).get("extraction", {})
    embeddings = (_tala_resolution or {}).get("embeddings", {})
    return json.dumps({
        "healthy": True,
        "mode": _mode,
        "configured": _mem0_config is not None,
        "backend": "qdrant",
        "extraction": {
            "enabled": extraction.get("enabled", False),
            "providerType": extraction.get("providerType", "none"),
            "model": extraction.get("model"),
            "reason": extraction.get("reason"),
        },
        "embeddings": {
            "enabled": embeddings.get("enabled", False),
            "providerType": embeddings.get("providerType", "none"),
            "model": embeddings.get("model"),
            "reason": embeddings.get("reason"),
        },
        "storage_path": "[REDACTED]",
    })

def _normalize_mem0_result(r):
    """
    Normalizes a Mem0 result item into a stable shape.
    Handles various backend response structures.
    """
    # Extract text (required)
    text = r.get("text") or r.get("content") or str(r)
    
    # Extract metadata (optional)
    metadata = r.get("metadata") or {}
    
    # Extract score (optional, default 0)
    score = r.get("score") or 0.0
    
    # Extract ID (optional, deterministic fallback)
    id_val = r.get("id") or r.get("memory_id") or f"mem_{hash(text) % 1000000}"
    
    return {
        "id": str(id_val),
        "text": text,
        "score": float(score),
        "metadata": metadata
    }

# --- OPERATIONAL TOOLS ---

@mcp.tool(name="mem0_add")
def mem0_add(text: str, user_id: str = "local_user", metadata: dict = None) -> str:
    """
    Add a memory to the vector store.
    """
    with _stderr_stdout():
        try:
            mem = get_memory()
            if mem is None:
                return json.dumps({"error": "Memory system is in a degraded state (initialization failed)."})
            result = mem.add(text, user_id=user_id, metadata=metadata)
            return json.dumps({"success": True, "message": "Memory added successfully.", "result": result})
        except BaseException as e:
            # Catch BaseException so SystemExit raised by mem0 embedding providers
            # (e.g. ollama embedder calling sys.exit(1) on a connection failure) does
            # not propagate and kill the MCP stdio transport.  KeyboardInterrupt is
            # re-raised so the server can still be interrupted cleanly.
            if isinstance(e, KeyboardInterrupt):
                raise
            sys.stderr.write(f"[mem0-core] ERROR in mem0_add: {type(e).__name__}: {e}\n")
            return json.dumps({"error": f"{type(e).__name__}: {e}"})

@mcp.tool(name="mem0_search")
def mem0_search(query: str, user_id: str = "local_user", limit: int = 5, filters: dict = None) -> str:
    """Search for relevant memories."""
    with _stderr_stdout():
        try:
            mem = get_memory()
            if mem is None:
                return json.dumps({"error": "Memory system is in a degraded state."})
            
            # Search the backend
            # Note: mem0 search usually doesn't take filters directly in the call, 
            # so we perform post-retrieval filtering for maximum compatibility.
            raw_results = mem.search(query, user_id=user_id, limit=limit)
            
            # Normalize all results
            normalized = [_normalize_mem0_result(r) for r in raw_results]
            
            # Apply filters (role, source)
            if filters:
                filtered = []
                for item in normalized:
                    match = True
                    for key, val in filters.items():
                        # Check if the filter key exists in metadata
                        item_val = item["metadata"].get(key)
                        if item_val != val:
                            match = False
                            break
                    if match:
                        filtered.append(item)
                return json.dumps(filtered)
                
            return json.dumps(normalized)
        except BaseException as e:
            # Catch BaseException so SystemExit raised by mem0 embedding providers
            # (e.g. ollama embedder calling sys.exit(1) on a connection failure) does
            # not propagate and kill the MCP stdio transport.  KeyboardInterrupt is
            # re-raised so the server can still be interrupted cleanly.
            if isinstance(e, KeyboardInterrupt):
                raise
            sys.stderr.write(f"[mem0-core] ERROR in mem0_search: {type(e).__name__}: {e}\n")
            return json.dumps({"error": f"{type(e).__name__}: {e}"})

# Readiness Signaling
# Important: Logging this to stderr so it doesn't break the JSON-RPC stream on stdout.
sys.stderr.write("mem0-core: READY (tools=5)\n")

if __name__ == "__main__":
    # Restore real stdout for MCP protocol transport
    sys.stdout = _real_stdout
    mcp.run()
