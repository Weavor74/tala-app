# Tala Memory Graph (MVGM)

The Tala Memory Graph is a production-grade, deterministic memory layer designed for reliability, traceability, and explainability. It implements a Minimal Viable Graph Memory (MVGM) that integrates with existing vector memory systems.

## 1. Architecture Overview

The system is organized into a modular pipeline:
1. **Extraction**: Raw text is parsed into `NodeCandidate` and `EdgeCandidate` atoms.
2. **Validation**: Candidates are filtered against safety and confidence policies.
3. **Storage**: Validated `NodeV1` and `EdgeV1` objects are stored idempotently in SQLite.
4. **Retrieval**: Context is retrieved using entity search followed by 1-hop neighborhood expansion.

## 2. Technical Specifications

### Schemas (v1)
All memory atoms are versioned and require:
- **Provenance**: A `source_ref` and `evidence_quote` (offset required for explicit facts).
- **Confidence**: A score (0-1) and a basis (`explicit`, `inferred`, `computed`).
- **Policy**: `RetentionPolicy` (`short`, `long`, `habit`, `never`) and `SensitivityLevel` (`low`, `medium`, `high`).

### Deterministic IDs
Node IDs are generated using a SHA-256 hash of the normalized `title` and `content`, ensuring that duplicate facts are updated rather than duplicated.

## 3. Policy Rules

- **Evidence Requirement**: Any fact marked as `EXPLICIT` MUST have an `evidence_quote`. Failure results in rejection.
- **Sensitivity Gating**: Content matching sensitive keywords (e.g., "password") is automatically marked with `SensitivityLevel.HIGH` and `RetentionPolicy.NEVER`.
- **Confidence Thresholding**: Entries below the configured threshold (default 0.5) are discarded.

## 4. HOW TO RUN

### Prerequisites
- Python 3.10+
- `pytest`
- `pydantic` v2

### Setup
Ensure your PYTHONPATH includes the project root:
```bash
set PYTHONPATH=%PYTHONPATH%;.
```

### Running Tests
Run the full production test suite:
```bash
.\local-inference\venv\Scripts\pytest.exe tala_project/memory/tests/
```

### Direct Usage Example
```python
from tala_project.memory.mem0_adapter import MemorySystem

# Initialize
sys = MemorySystem("tala_memory.db")

# Process an interaction
ids = sys.process_interaction("Tala is a production-grade assistant.", "session_001")

# Retrieve context for prompt injection
context = sys.retrieve_context("Tala")
print(context["context_str"])
```

## 5. Extensions

### Adding Node/Edge Types
1. Update `tala_project/memory/schema/models.py`.
2. Add new members to `NodeType` or `EdgeType` enums.
3. Update the `MemoryExtractor` logic in `extractor.py` to identify the new types.
4. Add corresponding validation rules in `validator.py`.
