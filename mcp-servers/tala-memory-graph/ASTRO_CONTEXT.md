# Phase 6 — Astro Emotion Context

This phase integrates the **Astro Emotion Engine** output into the memory retrieval pipeline. 

## 1. Safety Boundary: Context vs. Fact

> [!IMPORTANT]
> Emotion is a **transient filter**, not a **durable property** of a fact. 

- **Fact (Graph)**: "User encountered a build error in main.ts."
- **Context (Astro)**: "Current Emotion: FRUSTRATED. Salience: HIGH for Error-type events."

Emotion influences **Attention (what we look for)** and **Priority (what we show the LLM)**, but never the content of the memory itself.

## 2. Salience Weighting Module

The emotional state is mapped to a set of "Interest Vectors":

| Emotion | Boost Categories | Suppression Categories |
| :--- | :--- | :--- |
| **Happy** | Future goals, successes | Past errors |
| **Frustrated** | Technical blockers, debug logs | Secondary concepts |
| **Curious** | New entities, related_to edges | Rules / Constraints |

### Formula
`Salience(node) = BaseConfidence(node) * EmotionBoost(node.type) * Recency(node)`

## 3. Query Enrichment

During retrieval, the query is enriched with the current state:
- **Raw Query**: "What is the build system?"
- **Enriched Query**: "What is the build system? (Current Context: User is debugging a high-priority Error)."

## 4. Implementation (EmotionWeighter)

```python
class EmotionWeighter:
    def __init__(self, current_state: Dict[str, Any]):
        self.state = current_state

    def boost_score(self, node: MemoryNode) -> float:
        # Boost factor based on node type + current emotion
        # e.g., if emotion == 'stressed', boost 'event' nodes with 'error' tags.
        return 1.2 # Placeholder
```
