-- Up Migration

-- Server-side safety nets for the application role. They apply to every new
-- backend connection, including those PgBouncer opens, so a runaway query or a
-- transaction left open by a crashed client cannot hold locks indefinitely.
ALTER ROLE CURRENT_USER SET statement_timeout = '5s';
ALTER ROLE CURRENT_USER SET lock_timeout = '2s';
ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '10s';

-- Per-query latency and call counts, for finding slow queries in production.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Down Migration

DROP EXTENSION IF EXISTS pg_stat_statements;
ALTER ROLE CURRENT_USER RESET idle_in_transaction_session_timeout;
ALTER ROLE CURRENT_USER RESET lock_timeout;
ALTER ROLE CURRENT_USER RESET statement_timeout;
