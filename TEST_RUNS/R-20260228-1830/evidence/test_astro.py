import sys
import os
import json
from datetime import datetime

# Add the directory to sys.path so we can import the package
sys.path.append(r"d:\src\client1\tala-app\mcp-servers\astro-engine")

try:
    from astro_emotion_engine.mcp_server import get_raw_agent_emotional_state
    
    # We need to mock the profile if it doesn't exist, but let's try calling it first or listing profiles
    from astro_emotion_engine.mcp_server import list_agent_profiles
    print("Listing profiles...")
    print(list_agent_profiles())
    
    print("\nCalling get_raw_agent_emotional_state for 'default-tala'...")
    result = get_raw_agent_emotional_state("default-tala")
    print(result)
    
    with open(r"d:\src\client1\tala-app\TEST_RUNS\R-20260228-1830\evidence\astro_state.json", "w") as f:
        f.write(result)
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
