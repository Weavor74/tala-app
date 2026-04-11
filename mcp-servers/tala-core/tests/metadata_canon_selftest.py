import json
import os
import sys

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CORE_DIR = os.path.dirname(CURRENT_DIR)
if CORE_DIR not in sys.path:
    sys.path.insert(0, CORE_DIR)

from metadata_canon import canonicalize_metadata_for_storage, metadata_matches_filter


def run() -> None:
    frontmatter_like = {
        "source": r"D:\src\client1\tala-app\memory\processed\roleplay\LTMF-A17-0078-The-Delayed-Ping.md",
        "category": "roleplay",
        "is_structured": True,
        "id": "LTMF-A17-0078-The-Delayed-Ping_0",
        "age": "17",
        "canon": "true",
        "memory_type": "autobiographical",
        "source_type": "ltmf",
        "age_sequence": "78",
        "text": "Age / Life Stage: 17",
    }
    normalized_frontmatter = canonicalize_metadata_for_storage(frontmatter_like)
    assert normalized_frontmatter["age"] == 17
    assert normalized_frontmatter["canon"] is True
    assert normalized_frontmatter["source_type"] == "ltmf"
    assert normalized_frontmatter["memory_type"] == "autobiographical"
    assert normalized_frontmatter["age_sequence"] == 78

    legacy_ingested = {
        "source": r"D:\src\client1\tala-app\memory\processed\roleplay\LTMF-A17-0078-The-Delayed-Ping.md",
        "category": "roleplay",
        "is_structured": True,
        "id": "LTMF-A17-0078-The-Delayed-Ping_0",
        "age": 17,
        "text": "Source: LTMF-A17-0078-The-Delayed-Ping.md",
    }
    normalized_legacy = canonicalize_metadata_for_storage(legacy_ingested)
    assert normalized_legacy["source_type"] == "ltmf"
    assert normalized_legacy["memory_type"] == "autobiographical"
    assert normalized_legacy["canon"] is True
    assert normalized_legacy["age"] == 17
    assert isinstance(normalized_legacy.get("age_sequence"), int)

    strict_filter = {
        "age": 17,
        "source_type": "ltmf",
        "memory_type": "autobiographical",
        "canon": True,
    }
    assert metadata_matches_filter(legacy_ingested, strict_filter) is True

    print(
        json.dumps(
            {
                "ok": True,
                "normalized_frontmatter": normalized_frontmatter,
                "normalized_legacy": normalized_legacy,
                "strict_filter": strict_filter,
            }
        )
    )


if __name__ == "__main__":
    run()
