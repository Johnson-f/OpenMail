CREATE TABLE IF NOT EXISTS index_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'building',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  generation_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_part_id TEXT,
  source_type TEXT NOT NULL,
  source_location TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  internal_date INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_chunks_scope
  ON chunks (generation_id, account_id, internal_date);

CREATE INDEX IF NOT EXISTS idx_chunks_message
  ON chunks (account_id, message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS index_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  generation_id INTEGER NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_key, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_index_jobs_ready
  ON index_jobs (status, available_at, id);

CREATE TABLE IF NOT EXISTS index_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
