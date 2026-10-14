-- Retire the legacy synchronization schema (0001-0003). Its routes have returned 410
-- since 0004, and production held no legacy rows when checked on 2026-10-14.
-- Children first; their indexes are dropped with the tables.
DROP TABLE IF EXISTS device_links;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS recovery;
DROP TABLE IF EXISTS saves;
DROP TABLE IF EXISTS history;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS receipts;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS deletions;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS checks;
