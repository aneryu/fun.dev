-- The model library catalog (docs/models.md). name, kit and tags belong to the model; files
-- (name -> {sha256, size}), stats and the review status to each version.
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT,
  kit TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  listed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE versions (
  model TEXT NOT NULL REFERENCES models(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'pending', 'approved', 'rejected')),
  files TEXT NOT NULL DEFAULT '{}',
  stats TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  PRIMARY KEY (model, version)
);

CREATE INDEX versions_status ON versions(status, updated_at);
