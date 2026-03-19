from enum import Enum
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class NodeType(str, Enum):
    PERSON = "person"
    EVENT = "event"
    PLACE = "place"
    THING = "thing"
    CONCEPT = "concept"
    ORGANIZATION = "organization"
    PREFERENCE = "preference"
    BELIEF = "belief"
    FACT = "fact"


class EdgeType(str, Enum):
    RELATED_TO = "related_to"
    KNOWS = "knows"
    OWNS = "owns"
    LIVES_IN = "lives_in"
    WORKS_AT = "works_at"
    FRIEND_OF = "friend_of"
    CHILD_OF = "child_of"
    PARENT_OF = "parent_of"
    SIBLING_OF = "sibling_of"
    BORN_IN = "born_in"
    PART_OF = "part_of"
    CAUSED_BY = "caused_by"
    BELIEVES = "believes"


class ConfidenceBasis(str, Enum):
    EXPLICIT = "explicit"
    INFERRED = "inferred"
    OBSERVED = "observed"


class Provenance(BaseModel):
    source_ref: str = "unknown"


class Confidence(BaseModel):
    score: float = 1.0
    basis: ConfidenceBasis = ConfidenceBasis.INFERRED


class NodeV1(BaseModel):
    id: str
    type: NodeType
    title: str
    content: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)
    provenance: Provenance = Field(default_factory=Provenance)
    confidence: Confidence = Field(default_factory=Confidence)


class EdgeV1(BaseModel):
    source_id: str
    target_id: str
    relation: EdgeType
    weight: float = 1.0
    provenance: Provenance = Field(default_factory=Provenance)
    confidence: Confidence = Field(default_factory=Confidence)
