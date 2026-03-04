import sys
import os
# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
from memory_graph.server import mcp

print("Listing Registered Tools:")
for tool in mcp._tool_manager.list_tools():
    print(f"- {tool.name}: {tool.description}")

print("\nStep 4 Prove Visibility: SUCCESS")
