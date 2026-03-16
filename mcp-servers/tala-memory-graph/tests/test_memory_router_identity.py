import pytest
import os
import sys
# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
from memory_graph.router import MemoryRouter

def test_router_graph_selection():
    router = MemoryRouter()
    assert router.route("Who is Alice's dog?") == "graph"
    assert router.route("What happened before the station visit?") == "graph"
    assert router.route("Who is related to Buddy?") == "graph"

def test_router_identity_priority():
    router = MemoryRouter()
    assert router.route("Tell me about my childhood") == "graph"
    assert router.route("Find me on the map") == "graph"

def test_router_mem0_fallback():
    router = MemoryRouter()
    assert router.route("hello") == "mem0"
    assert router.route("what's up") == "mem0"

def test_router_rag_default():
    router = MemoryRouter()
    long_query = "Please provide a detailed explanation of the core architecture and its dependencies."
    assert router.route(long_query) == "rag"
