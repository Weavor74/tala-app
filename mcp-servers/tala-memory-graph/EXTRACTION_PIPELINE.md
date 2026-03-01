# Phase 2 — Memory Extraction Pipeline

This phase implements the deterministic extraction of **Memory Candidates** from raw system streams. 

## 1. Extraction Protocol

Every extraction must follow the "Evidence-First" rule. If no direct evidence snippet can be mapped to a fact, the fact is rejected.

### Sources
- **Chat Input**: Facts about the user, preferences, or project goals.
- **Tool Outputs**: Knowledge gained from file reading, web searching, or command execution (e.g., "Dependency X is at version Y").
- **System Events**: Errors, successes, or state changes (e.g., "Deployment failed due to SSL error").

## 2. Prompt Engineering (The Extractor)

The extractor uses a "Candidate" format to prevent automatic writes. Candidates must be validated by Phase 3 before storage.

**System Prompt Snippet**:
```text
Extract atomic facts from the following interaction. 
For each fact, you MUST provide:
1. Fact Content (ground truth)
2. Evidence Snippet (exact quote)
3. Confidence (0.0 - 1.0)
4. Entity/Concept Classification

Rule: Do not infer intent. Only extract what is explicitly stated or observed.
```

## 3. Candidate Data Structure

```python
class MemoryCandidate(BaseModel):
    content: str
    evidence: str
    source_id: str
    author: str
    type: NodeType
    suggested_edges: List[Dict[str, Any]] = []
    confidence: float
```

## 4. Implementation Strategy

- Use a lightweight SLM (e.g., Qwen3-8B) for initial extraction.
- Feed extraction candidates into a "Reasoning Buffer" for Phase 3 validation.
