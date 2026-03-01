import sys
import os
import json

# Add the directory to sys.path
sys.path.append(r"d:\src\client1\tala-app\mcp-servers\tala-core")

try:
    from server import ingest_file, search_memory
    
    run_id = "R-20260228-1830"
    needle = f"RAG_NEEDLE_{run_id}"
    doc_path = f"d:\\src\\client1\\tala-app\\TEST_RUNS\\{run_id}\\evidence\\rag_doc.md"
    
    with open(doc_path, "w") as f:
        f.write(f"# Test Doc\nRunID: {run_id}\nUnique phrase: {needle}\n")
    
    print(f"Ingesting: {doc_path}")
    ingest_res = ingest_file(doc_path)
    print(f"Ingest result: {ingest_res}")
    
    print(f"\nSearching for: {needle}")
    search_res = search_memory(needle)
    # print(f"Search result: {search_res}")
    
    with open(f"d:\\src\\client1\\tala-app\\TEST_RUNS\\{run_id}\\evidence\\rag_search.json", "w", encoding='utf-8') as f:
        json.dump(search_res, f, indent=2)
    print("Search result saved to rag_search.json")
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
