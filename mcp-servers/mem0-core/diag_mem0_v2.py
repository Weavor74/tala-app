import os
import sys
import traceback
import mem0

print(f"mem0 version: {mem0.__version__ if hasattr(mem0, '__version__') else 'unknown'}")

from mem0 import Memory

# Try minimal config
config = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
        }
    }
}

print(f"Attempting to initialize Memory with minimal config...")

try:
    memory = Memory(config=config)
    print("Memory initialized successfully with minimal config.")
except Exception as e:
    print("--- Minimal Config Failed ---")
    traceback.print_exc()

# Try NO config
print("Attempting to initialize Memory with NO config...")
try:
    memory = Memory()
    print("Memory initialized successfully with NO config.")
except Exception as e:
    print("--- NO Config Failed ---")
    traceback.print_exc()
