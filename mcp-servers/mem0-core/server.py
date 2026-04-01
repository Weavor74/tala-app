import sys
import os
import json
import io

# === CRITICAL: Redirect stdout to stderr BEFORE importing any third-party libs. ===
_real_stdout = sys.stdout
sys.stdout = sys.stderr

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    sys.stderr.write("[mem0-core] CRITICAL: 'mcp' library not found. Install with 'pip install mcp'.\n")
    sys.exit(1)

# Initialize FastMCP Server
mcp = FastMCP("mem0-core")

# Configuration for Mem0
config = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
        }
    },
    "embedder": {
        "provider": "ollama",
        "config": {
            "model": "nomic-embed-text:latest",
        }
    },
    "llm": {
        "provider": "ollama",
        "config": {
            "model": "huihui_ai/qwen3-abliterated:8b",
        }
    }
}

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
        try:
            sys.stderr.write("[mem0-core] Late-loading Mem0 library and initializing DB...\n")
            from mem0 import Memory
            _memory_instance = Memory.from_config(config)
            sys.stderr.write("[mem0-core] Memory initialized successfully.\n")
        except ImportError:
            sys.stderr.write("[mem0-core] ERROR: 'mem0ai' library not found. Running in degraded mode.\n")
            return None
        except BaseException as e:
            # Catch BaseException (including SystemExit) because some embedding providers
            # (e.g. mem0.embeddings.ollama) call sys.exit(1) on import failure rather than
            # raising a normal Exception.  Letting SystemExit propagate crashes the MCP
            # stdio server process; catching it here keeps the server alive in degraded mode.
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
        "configured": True,
        "backend": "qdrant",
        "embedder": "ollama",
        "storage_path": "[REDACTED]"
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
    try:
        mem = get_memory()
        if mem is None:
            return json.dumps({"error": "Memory system is in a degraded state (initialization failed)."})
        result = mem.add(text, user_id=user_id, metadata=metadata)
        return json.dumps({"success": True, "message": "Memory added successfully.", "result": result})
    except Exception as e:
        return json.dumps({"error": str(e)})

@mcp.tool(name="mem0_search")
def mem0_search(query: str, user_id: str = "local_user", limit: int = 5, filters: dict = None) -> str:
    """Search for relevant memories."""
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
    except Exception as e:
        return json.dumps({"error": str(e)})

# Readiness Signaling
# Important: Logging this to stderr so it doesn't break the JSON-RPC stream on stdout.
sys.stderr.write("mem0-core: READY (tools=5)\n")

if __name__ == "__main__":
    # Restore real stdout for MCP protocol transport
    sys.stdout = _real_stdout
    mcp.run()
