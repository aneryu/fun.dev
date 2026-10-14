PRAGMA foreign_keys = ON;
CREATE TABLE accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, recovery_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL, expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, transition_id TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE recovery (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending','active')),
  base_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX recovery_account ON recovery(account_id);
CREATE UNIQUE INDEX recovery_active ON recovery(account_id) WHERE state = 'active';
CREATE TABLE saves (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, game_id TEXT NOT NULL,
  revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, payload TEXT,
  bytes INTEGER NOT NULL DEFAULT 0, bundle_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(account_id,game_id)
);
CREATE TABLE history (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, game_id TEXT NOT NULL,
  revision INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,game_id,revision)
);
CREATE TABLE branches (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, game_id TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL, base_revision INTEGER NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(account_id,game_id,id)
);
CREATE TABLE receipts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, game_id TEXT NOT NULL,
  operation_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,game_id,operation_id)
);
CREATE TABLE deletions (digest TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- Temporary assertions force an entire D1 batch to roll back, including zero-row CAS failures.
CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  auth INTEGER NOT NULL DEFAULT 1 CONSTRAINT auth_required CHECK(auth = 1),
  rev INTEGER NOT NULL DEFAULT 1 CONSTRAINT revision_conflict CHECK(rev = 1),
  quota INTEGER NOT NULL DEFAULT 1 CONSTRAINT quota_exceeded CHECK(quota = 1),
  credential INTEGER NOT NULL DEFAULT 1 CONSTRAINT recovery_changed CHECK(credential = 1)
);
