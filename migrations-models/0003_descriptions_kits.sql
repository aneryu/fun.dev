-- A model's description ({zh, en}: what it is, how it looks, where it fits) and kits: models
-- built to one set of dimensions so they fit together, each with a description of that agreement
-- (docs/models.md).
ALTER TABLE models ADD COLUMN description TEXT;

CREATE TABLE kits (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
