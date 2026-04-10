"""
Tala Core MCP Server (Numpy Edition - Portable)

A simplified, robust RAG server using Numpy for vector operations.
Zero external database dependencies (no Chroma/SQLite/Rust).
Directly writes to .npy and .json files.

Exposes tools for:
  - **Memory search** — Semantic similarity search (dot product).
  - **Interaction logging** — Persist conversation embeddings.
  - **File ingestion** — Chunk and embed documents.
  - **File deletion** — Remove embeddings by source file.
  - **Index listing** — List indexed source files.
"""

import sys
import os
import json
import datetime

# === CRITICAL: Redirect stdout to stderr BEFORE importing heavy libs. ===
# sentence_transformers/transformers/huggingface_hub print progress info
# to stdout during import and model loading. MCP uses stdout as its
# transport, so any stray output corrupts the JSON stream.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

from typing import List, Dict, Any, Optional
import numpy as np
import yaml
import re
from sentence_transformers import SentenceTransformer
from mcp.server.fastmcp import FastMCP

# Initialize FastMCP Server
mcp = FastMCP("Tala Core")

# Configuration
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STORE_DIR = os.path.join(DATA_DIR, "simple_vector_store")
os.makedirs(STORE_DIR, exist_ok=True)

# Global Store
store = None

# Initialize Embedding Model
# using all-MiniLM-L6-v2 (384 dim)
sys.stderr.write("Loading model...\n")
model = SentenceTransformer('all-MiniLM-L6-v2')
sys.stderr.write("Model loaded.\n")

class SimpleVectorStore:
    def __init__(self, directory):
        self.directory = directory
        self.vectors_path = os.path.join(directory, "vectors.npy")
        self.metadata_path = os.path.join(directory, "metadata.json")
        self.vectors = None # numpy array
        self.metadata = []  # list of dicts
        self.load()

    def load(self):
        if os.path.exists(self.vectors_path) and os.path.exists(self.metadata_path):
            try:
                self.vectors = np.load(self.vectors_path)
                with open(self.metadata_path, 'r', encoding='utf-8') as f:
                    self.metadata = json.load(f)
                sys.stderr.write(f"Loaded {len(self.metadata)} entries from {self.directory}\n")
            except Exception as e:
                sys.stderr.write(f"Error loading store: {e}. Starting fresh.\n")
                self.vectors = np.empty((0, 384), dtype=np.float32)
                self.metadata = []
        else:
            self.vectors = np.empty((0, 384), dtype=np.float32)
            self.metadata = []

    def save(self):
        np.save(self.vectors_path, self.vectors)
        with open(self.metadata_path, 'w', encoding='utf-8') as f:
            json.dump(self.metadata, f, indent=2)

    def add(self, documents, embeddings, metadatas, ids):
        # embeddings: list of lists or numpy array
        new_vecs = np.array(embeddings, dtype=np.float32)
        
        # Check dimensions
        if new_vecs.shape[1] != 384:
            # Assuming model output is correct, but just in case
            pass 

        if self.vectors.shape[0] == 0:
            self.vectors = new_vecs
        else:
            self.vectors = np.vstack([self.vectors, new_vecs])
            
        # Add metadata with ID
        for i, meta in enumerate(metadatas):
            meta['id'] = ids[i]
            if 'text' not in meta:
                meta['text'] = documents[i] # Ensure text is stored fallback
            self.metadata.append(meta)
            
        self.save()

    def delete_by_source(self, source_path):
        if self.vectors.shape[0] == 0: return 0
        
        # Find indices to keep
        keep_indices = []
        new_metadata = []
        
        deleted_count = 0
        for i, meta in enumerate(self.metadata):
            if meta.get('source') != source_path:
                keep_indices.append(i)
                new_metadata.append(meta)
            else:
                deleted_count += 1
                
        if deleted_count > 0:
            self.vectors = self.vectors[keep_indices]
            self.metadata = new_metadata
            self.save()
            
        return deleted_count

    def search(self, query_vector, limit=3, filter_meta=None):
        if self.vectors.shape[0] == 0: return []
        
        # 1. Identify candidate indices based on filter
        if filter_meta:
            indices = []
            for i, meta in enumerate(self.metadata):
                match = True
                for k, v in filter_meta.items():
                    val = meta.get(k)
                    if isinstance(v, list):
                        if val not in v:
                            match = False
                            break
                    elif val != v:
                        match = False
                        break
                if match:
                    indices.append(i)
            indices = np.array(indices, dtype=int)
        else:
            indices = np.arange(self.vectors.shape[0], dtype=int)
            
        if len(indices) == 0: return []
            
        # 2. Slice vectors to candidates
        candidate_vectors = self.vectors[indices]
        
        # 3. Normalize Query
        norm = np.linalg.norm(query_vector)
        if norm > 0:
            query_norm = query_vector / norm
        else:
            query_norm = query_vector
        
        # 4. Compute Scores
        db_norms = np.linalg.norm(candidate_vectors, axis=1)
        db_norms[db_norms == 0] = 1e-10
        scores = np.dot(candidate_vectors, query_norm) / db_norms
        
        # 5. Top K
        # If limit is greater than available candidates, take all
        k = min(limit, len(scores))
        if k == 0: return []
        
        top_k_local = np.argsort(scores)[::-1][:k]
        
        results = []
        for local_idx in top_k_local:
            original_idx = indices[local_idx]
            match_meta = self.metadata[original_idx]
            match_score = float(scores[local_idx])
            
            results.append({
                'score': match_score,
                'metadata': match_meta,
                'text': match_meta.get('text', '')
            })
            
        return results

    def list_sources(self):
        sources = set()
        for meta in self.metadata:
            if 'source' in meta:
                sources.add(meta['source'])
        return sorted(list(sources))

# Initialize Store
store = SimpleVectorStore(STORE_DIR)

# --- MCP Tools ---

@mcp.tool()
def get_emotional_state(agent_id: str = "tala") -> str:
    """Returns calculated emotional state (Stub)."""
    header = "### SYSTEM INSTRUCTIONS: EMOTIONAL STATE [FOCUSED/INDUSTRIAL]\n"
    style = "- Voice: Quiet, Direct, Technical.\n- Metaphor: Mechanics, Pressure, Voltage.\n- Stance: The work comes first."
    return f"{header}\n{style}"

@mcp.tool()
def search_memory(query: str, limit: int = 3, filter_json: Optional[Any] = None) -> list[dict]:
    """
    Searches memory for relevant context using semantic similarity.
    Args:
        query: The search text representing the information you are looking for.
        limit: Max results to return.
        filter_json: Optional JSON string or Dict of metadata key-value pairs to filter by.
    """
    try:
        sys.stderr.write(f"[RAG] Search: '{query}' | Filter: {filter_json} (Type: {type(filter_json)})\n")
        query_vector = model.encode(query).tolist()
        
        filter_meta = None
        if filter_json:
            if isinstance(filter_json, str):
                try:
                    filter_meta = json.loads(filter_json)
                except Exception as je:
                    sys.stderr.write(f"[RAG] Filter JSON error: {je}\n")
            elif isinstance(filter_json, dict):
                filter_meta = filter_json
            else:
                sys.stderr.write(f"[RAG] Unsupported filter type: {type(filter_json)}\n")

        results = store.search(query_vector, limit, filter_meta)
        sys.stderr.write(f"[RAG] Found {len(results)} results\n")
        
        # Return structured list for client to format
        return results
    except Exception as e:
        sys.stderr.write(f"Search Error: {e}\n")
        return []


def _safe_int(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    s = str(raw).strip().lower()
    if not s:
        return None
    m = re.search(r'\b(\d{1,3})\b', s)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _parse_age_from_text(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        age = int(raw)
        return age if 0 <= age <= 130 else None
    text = str(raw).lower()
    # "age 17", "when you were 17", "at 17", "17 years old"
    m = re.search(r'(?:age\s*[:\-]?\s*|when\s+you\s+were\s+|at\s+)?(\d{1,2})(?:\s*(?:years?\s*old|yo))?\b', text)
    if m:
        age = int(m.group(1))
        return age if 0 <= age <= 130 else None
    return None


def _extract_ltmf_age(metadata_from_file: Dict[str, Any], file_path: str, content_for_indexing: str) -> Optional[int]:
    candidates = [
        metadata_from_file.get('age'),
        metadata_from_file.get('life_stage'),
        metadata_from_file.get('age_life_stage'),
        metadata_from_file.get('age_year'),
    ]
    for c in candidates:
        age = _parse_age_from_text(c)
        if age is not None:
            return age

    # File patterns: "...age_17..." or "LTMF-A17-....md"
    file_name = os.path.basename(file_path).lower()
    m_file_age = re.search(r'age[_\-\s]?(\d{1,2})', file_name)
    if m_file_age:
        age = int(m_file_age.group(1))
        if 0 <= age <= 130:
            return age

    m_ltmf_id = re.search(r'ltmf-a(\d{2})', file_name)
    if m_ltmf_id:
        age = int(m_ltmf_id.group(1))
        if 0 <= age <= 130:
            return age

    # Body pattern fallback: "Age / Life Stage: 17"
    m_content_age = re.search(r'age\s*/\s*life\s*stage\s*:\s*([^\n\r]+)', content_for_indexing, re.IGNORECASE)
    if m_content_age:
        age = _parse_age_from_text(m_content_age.group(1))
        if age is not None:
            return age

    return None


def _extract_age_sequence(metadata_from_file: Dict[str, Any], document_id: str, source_file_name: str, chunk_index: int) -> Optional[int]:
    for key in ('age_sequence', 'sequence', 'order', 'memory_index'):
        seq = _safe_int(metadata_from_file.get(key))
        if seq is not None and seq >= 0:
            return seq

    # Document IDs often encode "A17-0042" where the second group is sequence.
    m_doc = re.search(r'a\d{2}-(\d{1,6})', document_id.lower())
    if m_doc:
        return int(m_doc.group(1))

    # Filename fallback: "memory_07"
    m_file = re.search(r'memory[_\-\s]?(\d{1,4})', source_file_name.lower())
    if m_file:
        return int(m_file.group(1))

    # Preserve deterministic ordering even when no explicit sequence exists.
    return chunk_index

@mcp.tool()
def ingest_file(file_path: str, category: str = "general") -> str:
    """Ingests a file into memory with a specific category. Supports LTMF Markdown with YAML frontmatter."""
    if not os.path.exists(file_path):
        return f"Error: File not found {file_path}"
        
    try:
        # 1. Clean existing
        store.delete_by_source(file_path)
        
        with open(file_path, 'r', encoding='utf-8') as f:
            full_content = f.read()
            
        # 2. Extract YAML frontmatter if present
        metadata_from_file = {}
        content_for_indexing = full_content
        
        frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', full_content, re.DOTALL)
        if frontmatter_match:
            yaml_content = frontmatter_match.group(1)
            content_for_indexing = full_content[frontmatter_match.end():].strip()
            try:
                metadata_from_file = yaml.safe_load(yaml_content) or {}
            except Exception as ye:
                sys.stderr.write(f"[RAG] YAML parse error in {file_path}: {ye}\n")

        raw_chunks = [c.strip() for c in content_for_indexing.split('\n\n') if c.strip()]
        if not raw_chunks: return "File has no indexable content."

        # Smart Merge: Combine small chunks to preserve context (target ~1000 chars)
        chunks = []
        current_chunk = ""
        
        for c in raw_chunks:
            if len(current_chunk) + len(c) < 1000:
                current_chunk = f"{current_chunk}\n\n{c}" if current_chunk else c
            else:
                if current_chunk: chunks.append(current_chunk)
                current_chunk = c
        if current_chunk: chunks.append(current_chunk)

        ids = []
        embeddings = []
        metadatas = []
        docs = [] 
        
        import uuid
        document_id = metadata_from_file.get('id') or str(uuid.uuid4())
        source_file_name = os.path.basename(file_path)
        is_ltmf = bool(frontmatter_match) and (
            'ltmf' in source_file_name.lower()
            or str(document_id).lower().startswith('ltmf-')
            or category.lower() == 'roleplay'
        )
        extracted_age = _extract_ltmf_age(metadata_from_file, file_path, content_for_indexing) if is_ltmf else None
        
        chunk_texts = [f"Source: {os.path.basename(file_path)}\n\n{c}" for c in chunks if len(c) > 20]
        if not chunk_texts: return "No valid chunks extracted."
        
        vecs = model.encode(chunk_texts)
        
        # Parent Document Retrieval pattern: store the full content (minus frontmatter) in metadata
        # unless it's excessively large.
        stored_text_content = content_for_indexing
        if len(content_for_indexing) > 15000: 
             stored_text_content = None 
        
        for i, text in enumerate(chunk_texts):
            docs.append(text)
            embeddings.append(vecs[i])
            ids.append(f"{document_id}_{i}")
            
            final_text = stored_text_content if stored_text_content else text
            if stored_text_content and not final_text.startswith("Source:"):
                 final_text = f"Source: {os.path.basename(file_path)}\n\n{final_text}"

            # Merge file-level metadata with chunk metadata
            chunk_metadata = {
                "source": file_path,
                "timestamp": datetime.datetime.now().isoformat(),
                "type": "document",
                "category": category,
                "text": final_text,
                "is_structured": bool(frontmatter_match)
            }
            # Add LTMF-specific fields if they exist
            standard_fields = ['id', 'age', 'life_stage', 'emotional_state', 'emotional_weight', 'triggers', 'participants', 'location', 'tags']
            for field in standard_fields:
                if field in metadata_from_file:
                    chunk_metadata[field] = metadata_from_file[field]

            if is_ltmf:
                # Canonical autobiographical metadata for age-based retrieval.
                chunk_metadata["source_type"] = "ltmf"
                chunk_metadata["memory_type"] = "autobiographical"
                chunk_metadata["canon"] = True

                if extracted_age is not None:
                    chunk_metadata["age"] = extracted_age

                chunk_metadata["age_sequence"] = _extract_age_sequence(
                    metadata_from_file=metadata_from_file,
                    document_id=str(document_id),
                    source_file_name=source_file_name,
                    chunk_index=i,
                )

            metadatas.append(chunk_metadata)
            
        store.add(docs, embeddings, metadatas, ids)
        return f"Ingested {len(docs)} chunks from {os.path.basename(file_path)} (LTMF: {bool(frontmatter_match)})"
        
    except Exception as e:
        import traceback
        sys.stderr.write(traceback.format_exc())
        return f"Ingestion Error: {str(e)}"

@mcp.tool()
def delete_file_memory(file_path: str) -> str:
    """Deletes all memories for a file."""
    try:
        count = store.delete_by_source(file_path)
        return f"Deleted {count} chunks for {os.path.basename(file_path)}"
    except Exception as e:
        return f"Deletion Error: {str(e)}"

@mcp.tool()
def list_indexed_files() -> list[str]:
    """List all indexed source files."""
    try:
        return store.list_sources()
    except Exception as e:
        return [f"Error: {e}"]

@mcp.tool()
def log_interaction(user_text: str, agent_text: str) -> bool:
    """Logs conversation turn."""
    try:
        entry = f"User: {user_text}\nTala: {agent_text}"
        embedding = model.encode(entry)
        
        import uuid
        entry_id = str(uuid.uuid4())
        metadata = {
            "timestamp": datetime.datetime.now().isoformat(),
            "type": "conversation_turn",
            "source": "conversation_log",
            "category": "conversation"
        }
        
        store.add([entry], [embedding], [metadata], [entry_id])
        return True
    except Exception as e:
        sys.stderr.write(f"Log Interaction Error: {e}\n")
        return False

# --- MANDATORY TOOLS ---

@mcp.tool()
def ping() -> str:
    """Standard health check."""
    return "ok"

@mcp.tool()
def version() -> str:
    """Returns the package version."""
    return "1.5.0" # Tala Core version

@mcp.tool()
def status() -> str:
    """Returns the current internal status."""
    return json.dumps({
        "configured": True,
        "backend": "numpy",
        "model": "all-MiniLM-L6-v2",
        "index_size": len(store.metadata) if store else 0
    })

# Readiness Signaling
sys.stderr.write("tala-core: READY (tools=8)\n")

if __name__ == "__main__":
    # Restore real stdout for MCP protocol transport
    sys.stdout = _real_stdout
    mcp.run(transport='stdio')
