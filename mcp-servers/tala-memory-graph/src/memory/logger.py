import json
from datetime import datetime
from typing import Any, Dict

class AuditLogger:
    """Deterministic logging for memory operations to ensure auditability."""
    
    def __init__(self, log_path: str = "memory_audit.jsonl"):
        self.log_path = log_path

    def log(self, action: str, data: Dict[str, Any]):
        """Append a JSONL entry to the audit log."""
        entry = {
            "timestamp": datetime.now().isoformat(),
            "action": action.upper(),
            **data
        }
        with open(self.log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def log_commit(self, node_id: str, content: str, score: float):
        self.log("COMMIT", {
            "node_id": node_id,
            "content_summary": content[:50] + "...",
            "validation_score": round(score, 2),
            "status": "DURABLE"
        })

    def log_rejection(self, reason: str, candidate_content: str):
        self.log("REJECT", {
            "reason": reason,
            "content_preview": candidate_content[:50] + "..."
        })
