import sys
import os
import json

# Add the directory to sys.path
sys.path.append(r"d:\src\client1\tala-app\mcp-servers\mem0-core")

try:
    from server import add, search
    
    run_id = "R-20260228-1830"
    keyword = "MEM0_OK"
    text = f"TEST_RUN {run_id}: mem0 write/read validation. Keyword={keyword}"
    metadata = {"test_run": run_id, "tag": "mem0_smoke"}
    
    print(f"Adding memory: {text}")
    add_res = add(text, metadata=metadata)
    print(f"Add result: {add_res}")
    
    print(f"\nSearching for: {keyword} {run_id}")
    search_res = search(f"{keyword} {run_id}")
    print(f"Search result: {search_res}")
    
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
