ALTER TABLE saves ADD COLUMN reset_revision INTEGER NOT NULL DEFAULT 0;
UPDATE saves SET reset_revision=revision WHERE deleted=1;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX recovery_expiry ON recovery(state,expires_at);
CREATE INDEX receipts_expiry ON receipts(created_at);
CREATE INDEX history_expiry ON history(updated_at);
CREATE INDEX deletions_expiry ON deletions(completed_at);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
