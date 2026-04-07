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

# Import provider resolution.  This module NEVER prompts on stdin and NEVER
# raises SystemExit, so it is safe to call at import time.
from provider_resolver import (
    resolve_inference_backend,
    build_mem0_config_for_ollama,
    build_mem0_config_for_vllm,
)

# Initialize FastMCP Server
mcp = FastMCP("mem0-core")

# --- Startup provider health check ---
# Runs once at import time; logs to stderr only.  Selects the active backend
# and builds the mem0 config accordingly.  No prompts, no sys.exit.
_active_backend, _backend_info = resolve_inference_backend()

if _active_backend == "ollama":
    _mem0_config = build_mem0_config_for_ollama(_backend_info.get("endpoint"))
    sys.stderr.write("[mem0-core] Active provider: ollama\n")
elif _active_backend == "embedded_vllm":
    _mem0_config = build_mem0_config_for_vllm(
        _backend_info["endpoint"],
        _backend_info.get("model"),
    )
    sys.stderr.write(
        f"[mem0-core] Active fallback provider: embedded_vllm "
        f"({_backend_info['endpoint']})\n"
    )
else:
    # degraded — no mem0 config; get_memory() will return None
    _mem0_config = None
    sys.stderr.write("[mem0-core] Active provider: degraded (no inference backend available)\n")

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
    return json.dumps({
        "configured": _mem0_config is not None,
        "backend": "qdrant",
        "active_provider": _active_backend,
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
