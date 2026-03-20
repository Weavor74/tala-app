import yaml
import re
import hashlib
from typing import Dict, Any, Tuple, Optional

class LTMFParser:
    """
    Robust parser for LTMF Markdown files.
    Extracts YAML frontmatter and keeps Markdown body intact.
    """

    def parse_file(self, file_path: str) -> Tuple[Dict[str, Any], str, str]:
        """
        Parses an LTMF file.
        Returns (metadata, body, content_hash).
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Generate hash of total content for idempotency
            content_hash = hashlib.sha256(content.encode()).hexdigest()

            # Regex for YAML frontmatter
            frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
            if not frontmatter_match:
                # Fallback: Treat as plain markdown if no frontmatter
                return {}, content.strip(), content_hash

            yaml_content = frontmatter_match.group(1)
            body = content[frontmatter_match.end():].strip()
            
            try:
                metadata = yaml.safe_load(yaml_content) or {}
            except Exception as e:
                # Log YAML error but return empty meta to avoid crash
                import sys; sys.stderr.write(f"[LTMFParser] YAML parse error in {file_path}: {e}\n")
                metadata = {}

            return metadata, body, content_hash
            
        except Exception as e:
            import sys; sys.stderr.write(f"[LTMFParser] Error reading {file_path}: {e}\n")
            return {}, "", ""

    def validate_metadata(self, metadata: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """
        Validates required LTMF fields.
        """
        required = ['id', 'title', 'age', 'category']
        for field in required:
            if field not in metadata:
                return False, f"Missing required field: {field}"
        return True, None
