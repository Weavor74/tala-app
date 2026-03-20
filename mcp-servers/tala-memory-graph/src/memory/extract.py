from typing import List, Tuple, Dict, Any
from .candidates import NodeCandidate, EdgeCandidate
from .schema import NodeType, EdgeType, ConfidenceBasis
from .parser import LTMFParser
import re

class MemoryExtractor:
    """
    Deterministic extractor for memory candidates.
    Handles entity discovery from raw text.
    """

    def __init__(self, model_interface: any = None):
        self.model = model_interface

    def extract(self, raw_text: str, source_ref: str) -> Tuple[List[NodeCandidate], List[EdgeCandidate]]:
        nodes = []
        edges = []

        # 1. Simple Entity Regex (Fallback)
        match_entity = re.search(r"([A-Z][a-z]+)\s+is\s+an?\s+([a-z\-]+(?:\s+[a-z\-]+)*)", raw_text, re.IGNORECASE)
        if match_entity:
            entity_name = match_entity.group(1).capitalize()
            entity_type = match_entity.group(2).lower()
            nodes.append(NodeCandidate(
                type=NodeType.ENTITY,
                title=entity_name,
                content=f"{entity_name} is a {entity_type}.",
                evidence_quote=match_entity.group(0),
                format="txt"
            ))

        # 2. Heuristic Episodic Extraction (Location/Time/Event)
        # Looking for "Location:", "Time:", "Event:" labels or similar cues
        loc_match = re.search(r"Location:\s*(.*)", raw_text, re.I)
        event_match = re.search(r"Event:\s*(.*)", raw_text, re.I)
        
        if event_match:
            title = event_match.group(1).strip() if len(event_match.group(1)) < 50 else "New Episodic Event"
            nodes.append(NodeCandidate(
                type=NodeType.MEMORY,
                title=title,
                content=raw_text.strip(),
                evidence_quote=raw_text.strip(),
                format="txt",
                metadata={"source_ref": source_ref}
            ))
            
            if loc_match:
                loc_name = loc_match.group(1).strip()
                nodes.append(NodeCandidate(
                    type=NodeType.LOCATION,
                    title=loc_name,
                    content=f"Location: {loc_name}",
                    evidence_quote=loc_match.group(0),
                    format="txt"
                ))
                edges.append(EdgeCandidate(
                    source_id=None, # Will resolve to the memory node
                    target_title=loc_name,
                    relation=EdgeType.AT_LOCATION
                ))
                # Update main node metadata for episodic indexing
                nodes[0].metadata["location_id"] = loc_name
                
            # Time Extraction (Simple regex for age or year)
            time_match = re.search(r"Time:\s*(.*)", raw_text, re.I)
            if time_match:
                nodes[0].metadata["timestamp"] = time_match.group(1).strip()
                age_match = re.search(r"Age\s*(\d+)", time_match.group(1), re.I)
                if age_match:
                    nodes[0].age = float(age_match.group(1))

        return nodes, edges

class LTMFExtractor:
    """
    Specialized extractor for structured LTMF Markdown files.
    """
    def __init__(self):
        self.parser = LTMFParser()

    def extract_from_file(self, file_path: str) -> Tuple[List[NodeCandidate], List[EdgeCandidate]]:
        metadata, body, source_hash = self.parser.parse_file(file_path)
        if not metadata:
            return [], []

        nodes = []
        edges = []
        
        # 1. Main Memory Node
        mem_id = metadata.get('id')
        age = metadata.get('age')
        life_stage = metadata.get('life_stage')
        
        main_node = NodeCandidate(
            type=NodeType.MEMORY,
            id=mem_id, 
            title=metadata.get('title', 'Untitled Memory'),
            content=body,
            age=age,
            life_stage=life_stage,
            source_hash=source_hash,
            format="md",
            metadata=metadata,
            evidence_quote="Full LTMF content body"
        )
        # Store the explicit ID in metadata for the validator to pick up
        main_node.metadata['explicit_id'] = mem_id
        nodes.append(main_node)

        # 2. Extract Sub-Nodes (Triggers, Themes, etc.)
        mappings = [
            ('triggers', NodeType.TRIGGER, EdgeType.HAS_TRIGGER),
            ('themes', NodeType.THEME, EdgeType.HAS_THEME),
            ('patterns', NodeType.PATTERN, EdgeType.HAS_PATTERN),
            ('tendencies', NodeType.TENDENCY, EdgeType.HAS_TENDENCY),
            ('location', NodeType.LOCATION, EdgeType.AT_LOCATION),
        ]

        for key, node_type, edge_rel in mappings:
            val = metadata.get(key)
            if not val: continue
            
            # handle both list and single string
            items = val if isinstance(val, list) else [val]
            for item in items:
                item_node = NodeCandidate(
                    type=node_type,
                    title=str(item),
                    content=f"{node_type.value.capitalize()}: {item}",
                    confidence_basis=ConfidenceBasis.EXPLICIT,
                    evidence_quote=f"{key}: {item}",
                    format="md"
                )
                nodes.append(item_node)
                edges.append(EdgeCandidate(
                    source_id=mem_id,
                    target_title=str(item),
                    relation=edge_rel,
                    confidence_basis=ConfidenceBasis.EXPLICIT
                ))

        return nodes, edges
