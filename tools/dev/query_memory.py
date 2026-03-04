import sqlite3
import json
import os
import sys

# Default to the standard TALA memory path or use TALA_MEMORY_DB env var
tala_db = os.environ.get('TALA_MEMORY_DB', r'd:\src\client1\tala-app\mcp-servers\tala-memory-graph\tala_memory_v1.db')

if not os.path.exists(tala_db):
    print(f"DB not found at {tala_db}")
    print("Please set TALA_MEMORY_DB environment variable.")
    sys.exit(1)

query_term = sys.argv[1] if len(sys.argv) > 1 else 'user'

conn = sqlite3.connect(tala_db)
conn.row_factory = sqlite3.Row

print(f"--- Searching Nodes for '{query_term}' ---")
cursor = conn.execute("SELECT * FROM nodes WHERE name LIKE ? OR attrs_json LIKE ?;", (f'%{query_term}%', f'%{query_term}%'))
rows = cursor.fetchall()
for row in rows:
    print(dict(row))

print(f"\n--- Searching Edges for '{query_term}' ---")
cursor = conn.execute("SELECT * FROM edges WHERE attrs_json LIKE ?;", (f'%{query_term}%',))
rows = cursor.fetchall()
for row in rows:
    print(dict(row))

conn.close()
