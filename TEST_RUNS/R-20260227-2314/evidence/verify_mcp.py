import asyncio
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# RunID
RUN_ID = "R-20260227-2314"
BASE_PATH = r"d:\src\client1\tala-app"
EVIDENCE_DIR = os.path.join(BASE_PATH, "TEST_RUNS", RUN_ID, "evidence")
PYTHON_EXE = os.path.join(BASE_PATH, "mcp-servers", "tala-core", "venv", "Scripts", "python.exe")

async def test_astro(session):
    print("Listing Astro tools...")
    tools = await session.list_tools()
    tool_names = [t.name for t in tools.tools]
    print(f"Tools found: {tool_names}")
    
    # T-003 Check
    has_state = any("state" in name for name in tool_names)
    
    # T-004 Call
    print("Calling get_agent_emotional_state...")
    # Try different possible names based on survey
    call_name = "get_agent_emotional_state" if "get_agent_emotional_state" in tool_names else "get_emotional_state"
    result = await session.call_tool(call_name, {"agent_id": "tala"})
    
    output_path = os.path.join(EVIDENCE_DIR, "astro_state.json")
    with open(output_path, "w") as f:
        json.dump({"tools": tool_names, "response": result.content[0].text if result.content else ""}, f, indent=2)
    
    return {"id": "T-003", "status": "PASS" if has_state else "FAIL", "tools": tool_names}, {"id": "T-004", "status": "PASS" if result else "FAIL"}

async def test_mem0(session):
    print("Listing mem0 tools...")
    tools = await session.list_tools()
    tool_names = [t.name for t in tools.tools]
    print(f"Tools found: {tool_names}")
    
    # T-006 Add
    text = f"TEST_RUN {RUN_ID}: mem0 write/read validation. Keyword=MEM0_OK"
    print(f"Adding memory: {text}")
    add_result = await session.call_tool("add", {
        "text": text,
        "metadata": {"test_run": RUN_ID, "tag": "mem0_smoke"}
    })
    
    # T-007 Search
    print("Searching mem0...")
    search_result = await session.call_tool("search", {"query": f"MEM0_OK {RUN_ID}"})
    
    return {"id": "T-005", "status": "PASS" if "add" in tool_names and "search" in tool_names else "FAIL"}, \
           {"id": "T-006", "status": "PASS" if "successfully" in str(add_result).lower() else "FAIL"}, \
           {"id": "T-007", "status": "PASS" if "MEM0_OK" in str(search_result) else "FAIL", "result": str(search_result)}

async def test_rag(session):
    print("Listing RAG tools...")
    tools = await session.list_tools()
    tool_names = [t.name for t in tools.tools]
    print(f"Tools found: {tool_names}")
    
    # T-009 Ingest
    doc_path = os.path.join(EVIDENCE_DIR, "rag_doc.md")
    print(f"Ingesting file: {doc_path}")
    ingest_result = await session.call_tool("ingest_file", {"file_path": doc_path})
    
    # T-010 Search
    print("Searching RAG...")
    search_result = await session.call_tool("search_memory", {"query": f"RAG_NEEDLE_{RUN_ID}"})
    
    output_path = os.path.join(EVIDENCE_DIR, "rag_search.json")
    with open(output_path, "w") as f:
        json.dump({"tools": tool_names, "search_result": str(search_result)}, f, indent=2)
        
    return {"id": "T-008", "status": "PASS" if "ingest_file" in tool_names else "FAIL"}, \
           {"id": "T-009", "status": "PASS" if "ingested" in str(ingest_result).lower() else "FAIL"}, \
           {"id": "T-010", "status": "PASS" if f"RAG_NEEDLE_{RUN_ID}" in str(search_result) else "FAIL"}

async def main():
    results = []
    
    # 1. Astro
    try:
        astro_params = StdioServerParameters(
            command=PYTHON_EXE,
            args=["-m", "astro_emotion_engine.mcp_server"],
            cwd=os.path.join(BASE_PATH, "mcp-servers", "astro-engine"),
            env={**os.environ, "PYTHONUNBUFFERED": "1", "ASTRO_FORCE_FALLBACK": "1"}
        )
        async with stdio_client(astro_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                r1, r2 = await test_astro(session)
                results.extend([r1, r2])
    except Exception as e:
        results.append({"id": "T-003", "status": "FAIL", "errors": [str(e)]})
        results.append({"id": "T-004", "status": "FAIL", "errors": [str(e)]})

    # 2. mem0
    try:
        mem0_params = StdioServerParameters(
            command=PYTHON_EXE,
            args=[os.path.join(BASE_PATH, "mcp-servers", "mem0-core", "server.py")],
            cwd=BASE_PATH,
            env={**os.environ, "PYTHONUNBUFFERED": "1"}
        )
        async with stdio_client(mem0_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                r1, r2, r3 = await test_mem0(session)
                results.extend([r1, r2, r3])
    except Exception as e:
        results.extend([{"id": f"T-00{i}", "status": "FAIL", "errors": [str(e)]} for i in [5, 6, 7]])

    # 3. RAG
    try:
        rag_params = StdioServerParameters(
            command=PYTHON_EXE,
            args=[os.path.join(BASE_PATH, "mcp-servers", "tala-core", "server.py")],
            cwd=BASE_PATH,
            env={**os.environ, "PYTHONUNBUFFERED": "1", "RAG_PROVIDER": "simple-local"}
        )
        async with stdio_client(rag_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                r1, r2, r3 = await test_rag(session)
                results.extend([r1, r2, r3])
    except Exception as e:
        results.extend([{"id": f"T-0{i}", "status": "FAIL", "errors": [str(e)]} for i in ["08", "09", "10"]])

    print("\nFINAL RESULTS:")
    for r in results:
        print(json.dumps(r))

if __name__ == "__main__":
    asyncio.run(main())
