import os
import sys
import json
from datetime import datetime

# Add mcp-servers/mem0-core to path to import server
sys.path.append(os.path.join(os.getcwd(), 'mcp-servers', 'mem0-core'))

import server

content = f"TEST RUN {datetime.now().isoformat()} MEM0_OK"
metadata = {
    "test": "mem0_smoke",
    "source": "manual_validation"
}

print(f"Adding memory: {content}")
try:
    res = server.memory.add(content, user_id="local_user", metadata=metadata)
    print(f"Success: {json.dumps(res, indent=2)}")
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
