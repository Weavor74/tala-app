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

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel
import datetime
import os
import json
import numpy as np
from sentence_transformers import SentenceTransformer

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
print("Loading model...")
model = SentenceTransformer('all-MiniLM-L6-v2')
print("Model loaded.")

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
                print(f"Loaded {len(self.metadata)} entries from {self.directory}")
            except Exception as e:
                print(f"Error loading store: {e}. Starting fresh.")
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
def search_memory(query: str, limit: int = 3) -> list[dict]:
    """
    Searches memory for relevant context using semantic similarity.
    Args:
        query: The search text representing the information you are looking for.
        limit: Max results to return.
    """
    try:
        query_vector = model.encode(query).tolist()
        results = store.search(query_vector, limit, None)
        
        # Return structured list for client to format
        return results
    except Exception as e:
        # Return error as a single item list or throw? 
        # FastMCP handles exceptions but let's be safe
        print(f"Search Error: {e}")
        return []

@mcp.tool()
def ingest_file(file_path: str, category: str = "general") -> str:
    """Ingests a file into memory with a specific category."""
    if not os.path.exists(file_path):
        return f"Error: File not found {file_path}"
        
    try:
        # 1. Clean existing
        store.delete_by_source(file_path)
        
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        raw_chunks = [c.strip() for c in content.split('\n\n') if c.strip()]
        if not raw_chunks: return "File empty."

        # Smart Merge: Combine small chunks to preserve context (target ~1000 chars)
        chunks = []
        current_chunk = ""
        
        for c in raw_chunks:
            # If adding this chunk keeps us under limit, merge
            if len(current_chunk) + len(c) < 1000:
                current_chunk = f"{current_chunk}\n\n{c}" if current_chunk else c
            else:
                # Push current and start new
                if current_chunk: chunks.append(current_chunk)
                current_chunk = c
                
        if current_chunk: chunks.append(current_chunk)

        ids = []
        embeddings = []
        metadatas = []
        docs = [] # text
        
        import uuid
        base_id = str(uuid.uuid4())
        
        chunk_texts = [f"Source: {os.path.basename(file_path)}\n\n{c}" for c in chunks if len(c) > 20]
        if not chunk_texts: return "No valid chunks."
        
        vecs = model.encode(chunk_texts)
        
        # Optimization: For roleplay memories (small files), we want to retrieve the FULL context 
        # if any part matches. So we store the full content in the metadata 'text' field.
        # This implements "Parent Document Retrieval" pattern.
        stored_text_content = content
        if len(content) > 10000: # If huge file, keep chunk text to avoid context overflow
             stored_text_content = None # Will rely on fallback or chunk
        
        for i, text in enumerate(chunk_texts):
            docs.append(text)
            embeddings.append(vecs[i])
            ids.append(f"{base_id}_{i}")
            
            # If we have full content and it's reasonable size, use it. 
            # Otherwise use the chunk text.
            final_text = stored_text_content if stored_text_content else text
            # Ensure Source header is present in final text if using full content
            if stored_text_content and not final_text.startswith("Source:"):
                 final_text = f"Source: {os.path.basename(file_path)}\n\n{final_text}"

            metadatas.append({
                "source": file_path,
                "timestamp": datetime.datetime.now().isoformat(),
                "type": "document",
                "category": category,
                "text": final_text 
            })
            
        store.add(docs, embeddings, metadatas, ids)
        return f"Ingested {len(docs)} chunks from {os.path.basename(file_path)} (Category: {category})"
        
    except Exception as e:
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
        print(f"Log Interaction Error: {e}")
        return False

if __name__ == "__main__":
    mcp.run(transport='stdio')
