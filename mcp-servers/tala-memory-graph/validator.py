import re
from typing import List, Tuple
from extractor import MemoryCandidate
from models.schemas import PrivacyLevel, NodeType

class PolicyValidator:
    """Validates and scores memory candidates based on production-grade policies."""
    
    def __init__(self, confidence_threshold: float = 0.4):
        self.confidence_threshold = confidence_threshold
        # Basic patterns for sensitive data
        self.secret_patterns = [
            r"sk-[a-zA-Z0-9]{20,}", # Generic API key style
            r"password\s*=\s*['\"].*['\"]",
            r"bearer\s+[a-zA-Z0-9._-]{20,}"
        ]

    def _has_secrets(self, text: str) -> bool:
        """Check for potentially sensitive patterns."""
        for pattern in self.secret_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return True
        return False

    def score_confidence(self, candidate: MemoryCandidate) -> float:
        """
        Calculates a more rigorous confidence score.
        Weighted components:
        - Extraction Certainty (50%)
        - Evidence Length/Quality (50%)
        """
        # 1. Extraction certainty (from LLM)
        llm_score = candidate.confidence
        
        # 2. Evidence quality (heuristic based on length and snippet relevance)
        # In a real system, we'd check if the snippet is actually in the source file
        evidence_score = min(len(candidate.evidence) / 50.0, 1.0)
        
        final_score = (llm_score * 0.5) + (evidence_score * 0.5)
        return final_score

    def validate(self, candidate: MemoryCandidate) -> Tuple[bool, str]:
        """
        Performs full validation pass.
        Returns: (is_valid, reason)
        """
        # Check 1: Forbidden content (secrets)
        if self._has_secrets(candidate.content) or self._has_secrets(candidate.evidence):
            return False, "FORBIDDEN_CONTENT: Candidate contains potential secrets."

        # Check 2: Minimum Evidence quality
        if not candidate.evidence or len(candidate.evidence) < 10:
            return False, "LOW_EVIDENCE: Evidence snippet is missing or too short."

        # Check 3: Confidence threshold
        final_score = self.score_confidence(candidate)
        if final_score < self.confidence_threshold:
            return False, f"LOW_CONFIDENCE: Final score {final_score:.2f} is below threshold {self.confidence_threshold}."

        # Check 4: Domain constraints
        if candidate.type == NodeType.RULE and candidate.author != "user":
            # Only users (or system-defined core) can author rules
            return False, "DOMAIN_VIOLATION: Non-user author attempted to create a RULE node."

        return True, "VALIDATED"

    def apply_policies(self, candidate: MemoryCandidate) -> MemoryCandidate:
        """
        Adjusts candidate fields based on policy.
        Example: Force privacy level for certain types.
        """
        # Facts about the user are always PRIVATE
        if "user" in candidate.content.lower() or "i prefer" in candidate.evidence.lower():
            candidate.metadata["privacy_override"] = PrivacyLevel.PRIVATE
            
        return candidate
