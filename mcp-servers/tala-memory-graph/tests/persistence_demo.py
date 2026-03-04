import os
import sys
# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
from memory_graph.graph_store import GraphStore

DB_PATH = "demo_persistence.sqlite"

print("--- Persistence Demo ---")

# Stage 1: Write
print("Stage 1: Writing data...")
store1 = GraphStore(DB_PATH)
store1.upsert_node("demo_node", "test", "Persistence Target")
store1.close()
print("Object disconnected.")

# Stage 2: Verify
print("Stage 2: Re-connecting and verifying data...")
store2 = GraphStore(DB_PATH)
nodes = store2.search_nodes("Persistence Target")
if len(nodes) > 0 and nodes[0]['node_id'] == "demo_node":
    print("Verification: SUCCESS - Data persists.")
else:
    print("Verification: FAILED - Data lost.")

# Cleanup
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
