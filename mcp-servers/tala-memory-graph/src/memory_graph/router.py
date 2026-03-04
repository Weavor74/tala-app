import re
from typing import Dict, Any, List

class MemoryRouter:
    def __init__(self):
        # Keywords for graph (relationships, connections, timeline)
        self.graph_patterns = [
            r"related to", r"connected to", r"who is", r"what is",
            r"owns", r"lives in", r"works at", r"friend of",
            r"before", r"after", r"timeline", r"earlier", r"later",
            r"relationship", r"connection", r"owned by", r"child of",
            r"parent of", r"sibling of", r"born in"
        ]
        
        # Identity keywords for prioritized user-linked facts
        self.identity_patterns = [
            r"my", r"me", r"Steven", r"i have", r"i was", r"i am"
        ]

    def route(self, query: str) -> str:
        query_l = query.lower()
        
        # Check for identity + relationship
        for p in self.identity_patterns:
            if re.search(p, query_l):
                # Identity hit, check if it's also relational
                for gp in self.graph_patterns:
                    if re.search(gp, query_l):
                        return "graph"
                # If only identity but not relational, maybe still graph first for "who am I"
                return "graph"

        # Check for relational/timeline
        for p in self.graph_patterns:
            if re.search(p, query_l):
                return "graph"
                
        # Check for fuzzy recall (mem0) - default for now if no specific doc pattern
        if len(query.split()) < 5:
            return "mem0"
            
        # Default to RAG for long queries or document grounding
        return "rag"

if __name__ == "__main__":
    # Internal test
    router = MemoryRouter()
    print(f"Query: 'Who is related to Steven?' -> Route: {router.route('Who is related to Steven?')}")
    print(f"Query: 'What did I say earlier?' -> Route: {router.route('What did I say earlier?')}")
    print(f"Query: 'Tell me about the project architecture' -> Route: {router.route('Tell me about the project architecture')}")
