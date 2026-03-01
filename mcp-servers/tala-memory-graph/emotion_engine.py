from typing import Dict, Any, List
from models.schemas import MemoryNode, NodeType

class EmotionWeighter:
    """Modulates memory salience based on the agent's emotional state."""
    
    def __init__(self, current_emotion: str = "neutral", intensity: float = 0.5):
        self.emotion = current_emotion.lower()
        self.intensity = intensity
        
        # Define boost maps: Emotion -> {NodeType: BoostFactor}
        self.boost_map = {
            "happy": {NodeType.CONCEPT: 1.2, NodeType.ENTITY: 1.1},
            "frustrated": {NodeType.EVENT: 1.5, NodeType.RULE: 1.2},
            "curious": {NodeType.CONCEPT: 1.4, NodeType.ENTITY: 1.3},
            "stressed": {NodeType.EVENT: 1.3, NodeType.RULE: 1.5},
            "neutral": {nt: 1.0 for nt in NodeType}
        }

    def calculate_salience(self, node: MemoryNode) -> float:
        """
        Calculates the salience boost for a given node.
        Result is a multiplier for retrieval ranking.
        """
        base_boost = self.boost_map.get(self.emotion, self.boost_map["neutral"]).get(node.type, 1.0)
        
        # Scale boost by intensity
        # high intensity = more dramatic boost/suppression
        final_boost = 1.0 + (base_boost - 1.0) * self.intensity
        
        # Specific keyword heuristics (optional)
        if self.emotion == "frustrated" and "error" in node.content.lower():
            final_boost *= 1.2
            
        return final_boost

    def reorder_results(self, nodes: List[MemoryNode]) -> List[MemoryNode]:
        """Sorts memories by salience instead of just standard relevance."""
        # This would be used during the retrieval fusion step
        scored = [(node, self.calculate_salience(node)) for node in nodes]
        scored.sort(key=lambda x: x[1], reverse=True)
        return [x[0] for x in scored]
