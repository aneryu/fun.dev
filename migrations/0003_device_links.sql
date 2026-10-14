CREATE TABLE device_links (
  digest TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_links_expiry ON device_links(expires_at);
CREATE UNIQUE INDEX device_links_session ON device_links(session_id);
