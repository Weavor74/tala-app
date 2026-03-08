# DEPRECATED: Use scripts/diagnose_tala.ts instead.
# This script is kept for legacy reference only.

import sys
import os
import json
import asyncio
import sqlite3

# Add mcp-servers to path to import logic
sys.path.append(r"d:\src\client1\tala-app\mcp-servers\tala-memory-graph")

from src.memory import MemorySystem

async def run_diagnostic():
    report = []
    def log(msg):
        print(msg)
        report.append(msg)

    log("--- MEMORY SYSTEM DIAGNOSTIC ---")
    
    # 1. Initialize Memory Graph
    db_path = "tala_memory_v1.db"
    if not os.path.exists(db_path):
        db_path = os.path.join(r"d:\src\client1\tala-app\mcp-servers\tala-memory-graph", "tala_memory_v1.db")
    
    log(f"Loading Graph DB: {db_path}")
    memory = MemorySystem(db_path)
    
    # 0. Batch Ingest (Mass migration)
    log("\n[STEP 0] Mass Ingestion")
    md_dir = r"d:\src\client1\tala-app\memory\processed\roleplay_md"
    if os.path.exists(md_dir):
        res = memory.ingest_ltmf_directory(md_dir)
        log(f"Ingested from directory: {res}")
        log("Linking timeline...")
        memory.link_timeline()
        log("Timeline linked.")
    else:
        log(f"Directory not found: {md_dir}")
    
        # --- Step 2: Relationship Retrieval & Integrity ---
    log("\n[STEP 2] Graph Integrity & Retrieval")
    try:
        integrity = memory.graph.validate_integrity()
        log(f"Integrity Report: {json.dumps(integrity, indent=2)}")
        
        context = memory.retrieve_context("Levski station")
        log(f"Context results length: {len(context['context_str'])}")
    except Exception as e:
        log(f"Step 2 Error: {e}")

    # --- Step 3: Write & Verify Episodic Memory ---
    log("\n[STEP 3] Writing Episodic Memory")
    new_memory_text = """
    Location: Synthetica Garden, District 4
    Time: 2956 (Age 33)
    Who: Steve
    Event: We walked through the ozone-scented holographic ferns. I felt a rare sense of quiet stability.
    Emotional Context: Guarded contentment, curiosity.
    """
    try:
        results = memory.process_interaction(new_memory_text, "diagnostic_step_3")
        log(f"Ingested results: {results}")
        
        log("Verifying via search...")
        verify = memory.search("Synthetica Garden")
        if verify:
            log(f"Verified Node: {verify[0].id} - {verify[0].title}")
        else:
            log("Verification failed: memory not found after write.")
    except Exception as e:
        log(f"Step 3 Error: {e}")

    # --- Step 4: Multi-modal retrieval ---
    log("\n[STEP 4] Multi-modal Analysis")
    
    # Neighborhood
    if 'verify' in locals() and verify:
        node_id = verify[0].id
        log(f"Getting neighborhood for {node_id}")
        nodes, edges = memory.graph.get_neighborhood(node_id, hops=1)
        log(f"Neighborhood: {len(nodes)} nodes, {len(edges)} edges")
        for e in edges:
            log(f"  Edge: {e.source_id} --({e.relation})--> {e.target_id}")
            
    # Timeline
    log("\nTimeline Scan (Age 25-30):")
    timeline = memory.search("", filters={"age_min": 25, "age_max": 30})
    log(f"Memories found in age 25-30: {len(timeline)}")
    for m in timeline[:3]:
        log(f"  - [{m.age}] {m.title}")

    # --- Step 5: Episodic Search ---
    log("\n[STEP 5] Episodic (Spatial/Temporal) Search")
    try:
        from datetime import datetime
        # Search without timeframe first
        epi_results = memory.search_episodic(limit=5)
        log(f"Total episodic events found: {len(epi_results)}")
        for ev in epi_results[:3]:
            log(f"  - [{ev.title}] at {ev.metadata.get('timestamp')}")
    except Exception as e:
        log(f"Step 5 Error: {e}")

    with open(r"d:\src\client1\tala-app\diagnostic_report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(report))

asyncio.run(run_diagnostic())
