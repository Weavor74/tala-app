import os
import sys
import traceback
from mem0 import Memory
from mem0.config import MemoryConfig

config_dict = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
        }
    },
    "llm": {
        "provider": "huggingface", # Try using HF for LLM? Or just a dummy
        "config": {
            "model": "sentence-transformers/all-MiniLM-L6-v2", # This is an embedder but let's see
        }
    },
    "embedder": {
        "provider": "huggingface",
        "config": {
            "model": "sentence-transformers/all-MiniLM-L6-v2"
        }
    }
}

print("Attempting to initialize Memory with MemoryConfig object...")
try:
    config = MemoryConfig(**config_dict)
    memory = Memory(config=config)
    print("Memory initialized successfully with MemoryConfig!")
except Exception as e:
    print("--- MemoryConfig Failed ---")
    traceback.print_exc()
