import hashlib
from typing import List, Tuple, Optional
from .candidates import NodeCandidate, EdgeCandidate
from .schema import (
    NodeV1, EdgeV1, NodeType, EdgeType, 
    ConfidenceBasis, RetentionPolicy, SensitivityLevel,
    Provenance, Confidence
)

class MemoryValidator:
    """
    Validates memory candidates against production policies.
    Enforces evidence requirements and sensitivity gating.
    """

    def __init__(self, confidence_threshold: float = 0.5):
        self.confidence_threshold = confidence_threshold

    def _generate_deterministic_id(self, title: str, content: str) -> str:
        """Generates a stable ID based on normalized title and content."""
        seed = f"{title.strip().lower()}|{content.strip().lower()}"
        return hashlib.sha256(seed.encode()).hexdigest()[:16]

    def validate_node(self, candidate: NodeCandidate) -> Tuple[bool, Optional[str], Optional[NodeV1]]:
        # Rule 1: Explicit without evidence
        # Relaxed: Allow personal facts/entities without strict quotes to avoid over-filtering user data.
        if candidate.confidence_basis == ConfidenceBasis.EXPLICIT and not candidate.evidence_quote:
            if candidate.type in [NodeType.ENTITY, NodeType.MEMORY]:
                # Log warning instead of rejection for personal scope
                import sys; sys.stderr.write(f"[VALIDATION WARNING] Memory {candidate.title} has no evidence quote. Proceeding with caution.\n")
            else:
                return False, "EXPLICIT_WITHOUT_EVIDENCE: Explicit facts must have an evidence quote.", None

        # Rule 2: Sensitivity policy
        retention = RetentionPolicy.LONG
        sensitivity = SensitivityLevel.LOW
        if "password" in candidate.content.lower() or "secret" in candidate.content.lower():
            sensitivity = SensitivityLevel.HIGH
            retention = RetentionPolicy.NEVER

        # Rule 3: Confidence threshold
        score = 0.9 if candidate.confidence_basis == ConfidenceBasis.EXPLICIT else 0.6
        if score < self.confidence_threshold:
            return False, f"LOW_CONFIDENCE: Score {score} is below threshold {self.confidence_threshold}.", None

        # Create validated node
        explicit_id = candidate.metadata.get('explicit_id')
        node_id = explicit_id if explicit_id else self._generate_deterministic_id(candidate.title, candidate.content)
        
        node = NodeV1(
            id=node_id,
            type=candidate.type,
            title=candidate.title,
            content=candidate.content,
            metadata=candidate.metadata,
            provenance=Provenance(
                source_ref=candidate.metadata.get('source_path', "validated_stream"),
                evidence_quote=candidate.evidence_quote,
                evidence_offset=candidate.evidence_offset,
                author="system",
                format=candidate.format,
                source_hash=candidate.source_hash
            ),
            confidence=Confidence(score=score, basis=candidate.confidence_basis),
            retention=retention,
            sensitivity=sensitivity,
            age=candidate.age,
            life_stage=candidate.life_stage
        )

        return True, None, node

    def validate_edge(self, candidate: EdgeCandidate, source_id: str, target_id: str) -> Tuple[bool, Optional[str], Optional[EdgeV1]]:
        score = 0.7 
        if score < self.confidence_threshold and candidate.relation != EdgeType.MENTIONED_WITH:
            return False, "LOW_CONFIDENCE_EDGE: Relationship is too weak for durable storage.", None

        edge = EdgeV1(
            source_id=source_id,
            target_id=target_id,
            relation=candidate.relation,
            weight=score * 10.0,
            provenance=Provenance(source_ref="validated_stream"),
            confidence=Confidence(score=score, basis=candidate.confidence_basis)
        )
        return True, None, edge
