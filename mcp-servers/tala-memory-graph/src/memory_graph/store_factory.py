"""
Store factory for tala-memory-graph.

Resolution order:
  1. TALA_PG_DSN (or TALA_DATABASE_URL) → PostgresGraphStore
  2. TALA_MEMORY_DB set explicitly        → SQLite GraphStore (legacy/dev)
  3. Neither set                           → fail loudly (PostgreSQL preferred)

To opt-in to SQLite fallback during local development without a running
PostgreSQL instance, set TALA_MEMORY_DB to a file path.  This path
should *not* be set in production.
"""

from __future__ import annotations

import os
import sys
from typing import Union

from .graph_store import GraphStore


def create_store() -> Union["PostgresGraphStore", GraphStore]:  # noqa: F821
    """
    Return the appropriate graph store based on environment configuration.

    PostgreSQL is the default and preferred backend.  The SQLite path is
    retained only as an explicit opt-in fallback for local development.
    """
    pg_dsn = os.environ.get("TALA_PG_DSN") or os.environ.get("TALA_DATABASE_URL")

    if pg_dsn:
        # Import here so that psycopg2 is only required when PG is used.
        from .pg_store import PostgresGraphStore

        sys.stderr.write(
            "[store_factory] Connecting to PostgreSQL graph store.\n"
        )
        try:
            store = PostgresGraphStore(pg_dsn)
            sys.stderr.write(
                "[store_factory] PostgreSQL graph store ready.\n"
            )
            return store
        except Exception as exc:
            sys.stderr.write(
                f"[store_factory] FATAL: PostgreSQL connection failed: {exc}\n"
            )
            raise RuntimeError(
                "PostgreSQL is the required backend for tala-memory-graph. "
                "Check TALA_PG_DSN / TALA_DATABASE_URL and ensure PostgreSQL "
                "is running."
            ) from exc

    # SQLite fallback — only active when TALA_MEMORY_DB is explicitly set.
    sqlite_path = os.environ.get("TALA_MEMORY_DB")
    if sqlite_path:
        sys.stderr.write(
            f"[store_factory] WARNING: TALA_PG_DSN not set. "
            f"Using SQLite fallback: {sqlite_path}\n"
        )
        return GraphStore(sqlite_path)

    # Neither PG nor SQLite configured — fail clearly.
    raise RuntimeError(
        "No database backend configured for tala-memory-graph.\n"
        "Set TALA_PG_DSN (or TALA_DATABASE_URL) to a PostgreSQL connection "
        "string, or set TALA_MEMORY_DB to a SQLite file path for local "
        "development."
    )
