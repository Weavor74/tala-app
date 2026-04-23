import os
import sys

try:
    import chromadb
except ImportError as exc:
    print("ERROR: 'chromadb' is not installed in this interpreter.")
    print("Install it with the same interpreter used for this script, for example:")
    print(f"  {sys.executable} -m pip install chromadb")
    print(f"Details: {exc}")
    sys.exit(1)

# Path to the data directory
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(DATA_DIR, "chroma_db")

print(f"Inspecting ChromaDB at: {DB_PATH}")

if not os.path.exists(DB_PATH):
    print("ERROR: DB Path does not exist!")
    exit(1)

try:
    client = chromadb.PersistentClient(path=DB_PATH)
    print("Client initialized.")
    
    collections = client.list_collections()
    print(f"Collections found: {[c.name for c in collections]}")
    
    for c in collections:
        print(f"\n--- Collection: {c.name} ---")
        count = c.count()
        print(f"Count: {count}")
        
        if count > 0:
            peek = c.get(limit=5, include=['metadatas', 'documents'])
            print(f"First 5 metadatas: {peek['metadatas']}")
            
            # Check unique sources
            all_docs = c.get(include=['metadatas'], limit=100000) # Get all just to check sources
            sources = set()
            for m in (all_docs['metadatas'] or []):
                if 'source' in m:
                    sources.add(m['source'])
            print(f"Unique Sources count: {len(sources)}")
            print(f"First 10 sources: {list(sources)[:10]}")

except Exception as e:
    print(f"CRITICAL ERROR: {e}")
