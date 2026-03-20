from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from .schema import NodeType, EdgeType, ConfidenceBasis

class NodeCandidate(BaseModel):
    """A candidate node extracted from text, awaiting validation."""
    type: NodeType
    title: str
    content: str
    is_inference: bool = False
    evidence_quote: Optional[str] = None
    evidence_offset: Optional[int] = None
    confidence_basis: ConfidenceBasis = ConfidenceBasis.EXPLICIT
    metadata: Dict[str, Any] = Field(default_factory=dict)
    # V2 Fields
    age: Optional[float] = None
    life_stage: Optional[str] = None
    source_hash: Optional[str] = None
    format: str = "md"

class EdgeCandidate(BaseModel):
    """A candidate relationship extracted from text, awaiting validation."""
    source_id: Optional[str] = None # V2: explicit ID support
    source_title: Optional[str] = None
    target_id: Optional[str] = None # V2: explicit ID support
    target_title: Optional[str] = None
    relation: EdgeType
    is_inference: bool = False
    evidence_quote: Optional[str] = None
    confidence_basis: ConfidenceBasis = ConfidenceBasis.EXPLICIT
