from mcp.server.fastmcp import FastMCP
from src.memory import MemorySystem
import os

# Initialize FastMCP server
mcp = FastMCP("Tala Memory Graph")

# Initialize the memory system
# In production, this path could be configurable via ENV
DB_PATH = os.environ.get("TALA_MEMORY_DB", "tala_memory_v1.db")
memory = MemorySystem(DB_PATH)

@mcp.tool()
async def process_memory(text: str, source_ref: str = "interaction") -> list[str]:
    """
    Extracts, validates, and stores memories from a raw text interaction.
    Returns a list of IDs for the newly stored or updated memory nodes.
    """
    return memory.process_interaction(text, source_ref)

@mcp.tool()
async def retrieve_context(query: str, max_nodes: int = 5, max_edges: int = 5) -> str:
    """
    Retrieves structural context (nodes and relationships) relevant to a query.
    Used for injecting relevant memories into an LLM prompt.
    """
    result = memory.retrieve_context(query, max_nodes, max_edges)
    return result["context_str"]

@mcp.tool()
async def search_memories(query: str, limit: int = 10) -> list[dict]:
    """
    Searches for memory nodes matching a query string.
    """
    nodes = memory.search(query)
    return [node.model_dump() for node in nodes]

@mcp.tool()
async def get_neighborhood(node_id: str, hops: int = 1) -> dict:
    """
    Returns the structural neighborhood (connected nodes and edges) of a specific node.
    """
    nodes, edges = memory.graph.get_neighborhood(node_id, hops)
    return {
        "nodes": [n.model_dump() for n in nodes],
        "edges": [e.model_dump() for e in edges]
    }

if __name__ == "__main__":
    mcp.run()
