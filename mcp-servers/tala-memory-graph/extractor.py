from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime
from models.schemas import NodeType, Provenance, ConfidenceScore

class MemoryCandidate(BaseModel):
    """A memory atom awaiting validation."""
    content: str
    type: NodeType
    evidence: str
    source_id: str
    author: str = "system"
    confidence: float = 0.5
    metadata: Dict[str, Any] = {}
    suggested_edges: List[Dict[str, Any]] = []

class ExtractionResult(BaseModel):
    """Result of an extraction pass."""
    candidates: List[MemoryCandidate]
    raw_response: str
    timestamp: datetime = Field(default_factory=datetime.now)

class MemoryExtractor:
    """Orchestrates memory extraction from various sources."""
    
    def __init__(self, model_name: str = "qwen3-8b"):
        self.model_name = model_name

    def build_extraction_prompt(self, context: str, source_id: str) -> str:
        """Constructs the prompt for the LLM to extract facts."""
        return f"""
Analyze the following interaction context and extract atomic, deterministic facts.

[CONTEXT]
Source: {source_id}
Data:
\"\"\"{context}\"\"\"

[EXTRACTION RULES]
1. Extracts MUST be atomic facts (no compound sentences).
2. Each fact MUST have an 'evidence' string quoted directly from the context.
3. Classify each fact as: 'entity', 'concept', 'event', or 'rule'.
4. If no clear facts are found, return an empty list.
5. Provide a confidence score (0.0-1.0) based on how explicit the statement is.

[OUTPUT FORMAT]
Response must be a JSON array of objects:
[
  {{
    "content": "Fact string",
    "type": "entity|concept|event|rule",
    "evidence": "quoted evidence",
    "confidence": 0.9,
    "suggested_edges": [
      {{"target": "RelatedNodeID", "relation": "related_to"}}
    ]
  }}
]
"""

    async def extract_from_text(self, text: str, source_id: str, author: str = "system") -> ExtractionResult:
        """
        Simulates the extraction call. 
        In production, this would call the LLM inference engine.
        """
        # Placeholder for AI call
        # Mock result for logic testing:
        return ExtractionResult(
            candidates=[],
            raw_response="[]"
        )
