import os
import sys
import traceback

try:
    from mem0 import Memory
    print("mem0 package imported successfully.")
except ImportError:
    print("Error: mem0 package not found.")
    sys.exit(1)

config = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
        }
    },
    "embedder": {
        "provider": "huggingface",
        "config": {
            "model": "sentence-transformers/all-MiniLM-L6-v2"
        }
    }
}

print(f"Attempting to initialize Memory with path: {config['vector_store']['config']['path']}")

try:
    memory = Memory(config=config)
    print("Memory initialized successfully.")
except Exception as e:
    print("--- Initialization Failed ---")
    traceback.print_exc()
    sys.exit(1)
