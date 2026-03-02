import sys

# === CRITICAL: Redirect stdout to stderr BEFORE any imports ===
# MCP uses stdout as its JSON-RPC transport. Any stray print() from
# imported libs will corrupt the stream. Swap before importing.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

from mcp.server.fastmcp import FastMCP
from src.memory import MemorySystem
import os
from datetime import datetime

# Initialize FastMCP server
mcp = FastMCP("Tala Memory Graph")

# Initialize the memory system
# In production, this path could be configurable via ENV
DB_PATH = os.environ.get("TALA_MEMORY_DB", "tala_memory_v1.db")
memory = MemorySystem(DB_PATH)

from typing import List, Dict, Any, Optional

@mcp.tool()
async def process_memory(text: str, source_ref: str = "interaction") -> List[str]:
    """
    Extracts, validates, and stores memories from a raw text interaction.
    """
    return memory.process_interaction(text, source_ref)

@mcp.tool()
async def ingest_ltmf_directory(directory_path: str) -> dict:
    """
    Recursively scans and ingests all structured LTMF Markdown files in a directory.
    Useful for initial migration or periodic updates.
    """
    return memory.ingest_ltmf_directory(directory_path)

@mcp.tool()
async def link_timeline() -> str:
    """
    Automatically creates NEXT/PREV edges between memory nodes based on age.
    Should be run after batch ingestion.
    """
    memory.link_timeline()
    return "Timeline edges reconstructed."

@mcp.tool()
async def retrieve_context(query: str, max_nodes: int = 5, max_edges: int = 5, 
                         emotion: str = "neutral", intensity: float = 0.5,
                         filters: Optional[dict] = None) -> str:
    """
    Retrieves structural context (nodes and relationships) relevant to a query.
    Takes optional filters (age_min, age_max, type, id_prefix).
    """
    result = memory.retrieve_context(query, max_nodes, max_edges, emotion, intensity, filters=filters)
    return result["context_str"]

@mcp.tool()
async def search_memories(query: str, limit: int = 10, filters: Optional[dict] = None) -> List[Dict[str, Any]]:
    """
    Searches for memory nodes matching a query string.
    Takes optional filters (age_min, age_max, type, id_prefix).
    """
    nodes = memory.search(query, filters=filters)
    return [node.model_dump() for node in nodes]

@mcp.tool()
async def validate_integrity() -> dict:
    """
    Performs validation of the graph state (idempotency, duplicates, timeline breaks).
    """
    return memory.graph.validate_integrity()

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

@mcp.tool()
async def graph_search_episodic(location: Optional[str] = None, 
                               start_time: Optional[str] = None, 
                               end_time: Optional[str] = None, 
                               limit: int = 10) -> List[Dict[str, Any]]:
    """
    Searches for episodic memory nodes matching a location and/or timeframe.
    Time should be in ISO format (e.g. '2023-10-27T10:00:00').
    """
    timeframe = None
    if start_time and end_time:
        try:
            timeframe = (datetime.fromisoformat(start_time), datetime.fromisoformat(end_time))
        except ValueError:
            pass # Or handle error
    
    nodes = memory.search_episodic(location, timeframe, limit)
    return [node.model_dump() for node in nodes]

if __name__ == "__main__":
    sys.stdout = _real_stdout  # restore for MCP protocol transport
    mcp.run()
