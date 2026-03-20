-- 006_graph_nodes_edges.sql
-- Graph-layer tables for tala-memory-graph MCP server.
--
-- These tables use TEXT primary keys (not UUIDs) so the Python MCP server can
-- generate its own IDs without a database round-trip.  They are prefixed with
-- graph_ to coexist with the canonical entity / relationship tables defined in
-- the earlier migrations.

CREATE TABLE IF NOT EXISTS graph_nodes (
    node_id    TEXT        PRIMARY KEY,
    type       TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    attrs_json TEXT        NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id    TEXT        PRIMARY KEY,
    src_id     TEXT        NOT NULL,
    dst_id     TEXT        NOT NULL,
    rel_type   TEXT        NOT NULL,
    attrs_json TEXT        NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS graph_events (
    event_id       TEXT        PRIMARY KEY,
    title          TEXT        NOT NULL,
    body           TEXT        NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    entities_json  TEXT        NOT NULL DEFAULT '[]',
    sentiment_json TEXT        NOT NULL DEFAULT '{}',
    attrs_json     TEXT        NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS graph_evidence (
    evidence_id TEXT        PRIMARY KEY,
    kind        TEXT        NOT NULL,
    ref         TEXT        NOT NULL,
    node_id     TEXT        REFERENCES graph_nodes(node_id) ON DELETE SET NULL,
    edge_id     TEXT        REFERENCES graph_edges(edge_id) ON DELETE SET NULL,
    event_id    TEXT        REFERENCES graph_events(event_id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_rel  ON graph_edges(rel_type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_src  ON graph_edges(src_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst  ON graph_edges(dst_id);
CREATE INDEX IF NOT EXISTS idx_graph_events_ts  ON graph_events(ts);
