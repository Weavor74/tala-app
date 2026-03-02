import sys
import os

# Add src to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'src')))

from memory import MemorySystem

def test_mcp_logic():
    print("Testing MCP Logic...")
    memory = MemorySystem("mcp_test.db")
    
    # Test process_interaction
    print("1. Testing process_interaction...")
    text = "Tala is a production-grade assistant."
    ids = memory.process_interaction(text, "mcp_test_source")
    print(f"Stored IDs: {ids}")
    assert len(ids) == 1
    
    # Retrieve context
    print("2. Testing retrieve_context with emotion...")
    context = memory.retrieve_context("Tala", emotion="happy", intensity=1.0)
    print(f"Context:\n{context['context_str']}")
    assert "HAPPY" in context['context_str']
    assert "Tala is a production-grade assistant" in context['context_str']
    
    # Check Audit Log
    print("3. Checking Audit Log...")
    if os.path.exists("memory_audit.jsonl"):
        print("Audit log exists and verified.")
    else:
        raise Exception("Audit log missing!")
    
    # Close connection
    del memory
    import gc
    gc.collect()
    
    print("ALL MCP LOGIC TESTS PASSED")
    
    # Cleanup
    if os.path.exists("mcp_test.db"):
        os.remove("mcp_test.db")

if __name__ == "__main__":
    try:
        test_mcp_logic()
    except Exception as e:
        print(f"TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
