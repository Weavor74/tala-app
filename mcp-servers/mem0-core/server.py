"""
Mem0 Core MCP Server

Short-term fact memory backed by the Mem0 library.
Provides two MCP tools:
  - ``add``   — Store a text memory with optional metadata.
  - ``search`` — Retrieve relevant memories by semantic similarity.

Data is persisted locally under ``data/mem0_storage/`` relative to CWD.
The embedding model and vector store are managed internally by Mem0.
"""

from mcp.server.fastmcp import FastMCP
from mem0 import Memory
import os

# Initialize FastMCP Server
mcp = FastMCP("mem0-core")

# Initialize Local Mem0
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

os.environ["MEM0_DIR"] = os.path.join(os.getcwd(), "data", "mem0_storage")
if not os.path.exists(os.environ["MEM0_DIR"]):
    os.makedirs(os.environ["MEM0_DIR"])

try:
    print(f"[mem0-core] Initializing Memory from config...")
    memory = Memory.from_config(config)
    print("[mem0-core] Memory initialized successfully.")
except Exception as e:
    import traceback
    print(f"[mem0-core] Failed to initialize Memory: {e}")
    traceback.print_exc()
    memory = None

@mcp.tool()
def add(text: str, user_id: str = "local_user", metadata: dict = None) -> str:
    """
    Add a memory to the vector store.

    Args:
        text: The text content to memorize.
        user_id: Owner identifier (default ``"local_user"``).
        metadata: Optional dictionary of key/value tags for filtering.

    Returns:
        Success confirmation or error message.
    """
    try:
        memory.add(text, user_id=user_id, metadata=metadata)
        return "Memory added successfully."
    except Exception as e:
        return f"Error adding memory: {str(e)}"

@mcp.tool()
def search(query: str, user_id: str = "local_user", limit: int = 5) -> str:
    """Search for relevant memories."""
    try:
        results = memory.search(query, user_id=user_id, limit=limit)
        # Format results as string or return list
        return str([{"text": r["text"], "score": r.get("score", 0)} for r in results])
    except Exception as e:
        return f"Error searching memory: {str(e)}"

if __name__ == "__main__":
    mcp.run()
