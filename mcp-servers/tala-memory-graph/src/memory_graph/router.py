import re
from typing import Dict, Any, List

class MemoryRouter:
    def __init__(self, user_id: str = None):
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
            r"\bmy\b", r"\bme\b", r"\bi\b", r"\bmine\b"
        ]
        if user_id:
            self.identity_patterns.append(re.escape(user_id))

    def route(self, query: str, user_id: str = None) -> str:
        # Update identity patterns if user_id is provided dynamically
        patterns = self.identity_patterns.copy()
        if user_id and re.escape(user_id) not in patterns:
            patterns.append(re.escape(user_id))
            
        query_l = query.lower()
        
        # Check for identity + relationship
        for p in patterns:
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
    print(f"Query: 'Who is related to Alex?' -> Route: {router.route('Who is related to Alex?')}")
    print(f"Query: 'What did I say earlier?' -> Route: {router.route('What did I say earlier?')}")
    print(f"Query: 'Tell me about the project architecture' -> Route: {router.route('Tell me about the project architecture')}")
