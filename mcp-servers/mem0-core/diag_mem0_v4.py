import os
import sys
import traceback
import mem0
from mem0 import Memory

# Dynamically import MemoryConfig from wherever it is
try:
    from mem0.configs.base import MemoryConfig
    print("Found MemoryConfig in mem0.configs.base")
except ImportError:
    try:
        from mem0.config import MemoryConfig
        print("Found MemoryConfig in mem0.config")
    except ImportError:
        MemoryConfig = None
        print("Could not find MemoryConfig")

config_dict = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": os.path.join(os.getcwd(), "data", "qdrant_db"),
        }
    },
    "llm": {
        "provider": "local",
        "config": {
            "model": "none",
        }
    },
    "embedder": {
        "provider": "huggingface",
        "config": {
            "model": "all-MiniLM-L6-v2"
        }
    }
}

print("Attempting to initialize Memory...")
try:
    if MemoryConfig:
        mc = MemoryConfig(**config_dict)
        # Check if mc.llm.config is a dict or object
        print(f"mc.llm.config type: {type(mc.llm.config)}")
        memory = Memory(config=mc)
    else:
        memory = Memory(config=config_dict)
    print("Memory initialized successfully!")
except Exception as e:
    print(f"Failed: {e}")
    traceback.print_exc()
