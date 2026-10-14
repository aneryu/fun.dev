-- Additive migration: legacy accounts/saves are retained for operator export.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  link TEXT NOT NULL,
  recipient TEXT,
  deadline INTEGER NOT NULL,
  receipt_until INTEGER NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','claimed','committed','cancelled','expired')),
  payload TEXT,
  bytes INTEGER NOT NULL CHECK(bytes >= 0)
);
CREATE INDEX transfers_deadline ON transfers(state,deadline);
CREATE INDEX transfers_receipt ON transfers(receipt_until);
CREATE TABLE relay_usage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  records INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  CONSTRAINT relay_capacity CHECK(records BETWEEN 0 AND 4096 AND bytes BETWEEN 0 AND 67108864)
);
INSERT INTO relay_usage VALUES(1,0,0);
CREATE TRIGGER transfers_insert AFTER INSERT ON transfers BEGIN
  UPDATE relay_usage SET records=records+1,bytes=bytes+NEW.bytes WHERE id=1;
END;
CREATE TRIGGER transfers_update AFTER UPDATE OF bytes ON transfers BEGIN
  UPDATE relay_usage SET bytes=bytes+NEW.bytes-OLD.bytes WHERE id=1;
END;
CREATE TRIGGER transfers_delete AFTER DELETE ON transfers BEGIN
  UPDATE relay_usage SET records=records-1,bytes=bytes-OLD.bytes WHERE id=1;
END;
-- Fixed 256 network buckets per operation class; random IDs cannot grow this table.
CREATE TABLE transfer_rates (
  bucket INTEGER PRIMARY KEY CHECK(bucket BETWEEN 0 AND 511),
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX transfer_rates_expiry ON transfer_rates(expires_at);
