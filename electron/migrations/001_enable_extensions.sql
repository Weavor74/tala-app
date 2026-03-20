-- 001_enable_extensions.sql
-- Enable required PostgreSQL extensions for Tala canonical memory.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
