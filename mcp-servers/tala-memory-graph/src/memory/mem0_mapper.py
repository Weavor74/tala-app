from typing import List, Optional, Dict, Any

class Mem0Mapper:
    """
    Mapping layer between Mem0 facts and the Multi-turn Memory Graph.
    Ensures that Mem0 entries can reference stable Graph IDs.
    """

    def __init__(self, memory_system):
        self.memory = memory_system

    def link_fact_to_graph(self, mem0_id: str, mem0_metadata: Dict[str, Any], graph_id: str):
        """
        Adds a graph reference to Mem0 metadata.
        """
        refs = mem0_metadata.get('graph_refs', [])
        if graph_id not in refs:
            refs.append(graph_id)
        mem0_metadata['graph_refs'] = refs
        return mem0_metadata

    def infer_graph_link(self, fact_text: str) -> Optional[str]:
        """
        Attempts to find a matching graph node for a raw Mem0 fact string.
        Uses a simple title-based or content-based similarity search.
        """
        # Simple heuristic: look for matches in the graph
        results = self.memory.search(fact_text, filters={"limit": 1})
        if results:
            return results[0].id
        return None
