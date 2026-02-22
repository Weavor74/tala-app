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

# Initialize Local Mem0 (defaults to ~/.mem0 or local DB)
# In production, might want to configure path to be internal to app
# Configure for local/portable usage
config = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
            "host": "localhost",
            "port": 6333,
            # "on_disk": True # faster startup
        }
    },
    "embedder": {
        "provider": "huggingface",
        "config": {
            "model": "sentence-transformers/all-MiniLM-L6-v2"
        }
    }
}

os.environ["MEM0_DIR"] = os.path.join(os.getcwd(), "data", "mem0_storage")
if not os.path.exists(os.environ["MEM0_DIR"]):
    os.makedirs(os.environ["MEM0_DIR"])

try:
    memory = Memory(config=config)
except Exception as e:
    print(f"Failed to initialize Memory: {e}")
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
