-- SQLite schema for the local-first Gmail store.
-- All timestamps are INTEGER Unix milliseconds. Gmail ids are TEXT and are
-- never parsed as numbers. Every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  history_id TEXT,
  encrypted_refresh_token BLOB NOT NULL,
  backfill_page_token TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  subject TEXT,
  participants TEXT DEFAULT '[]',
  last_message_at INTEGER,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  from_addr TEXT,
  to_addrs TEXT DEFAULT '[]',
  cc_addrs TEXT DEFAULT '[]',
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  internal_date INTEGER,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS labels (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  type TEXT,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS message_labels (
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id, label_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  attachment_id TEXT,
  PRIMARY KEY (account_id, message_id, part_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  add_labels TEXT DEFAULT '[]',
  remove_labels TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at INTEGER,
  uploaded_at_history_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_account_thread_date
  ON messages (account_id, thread_id, internal_date);

CREATE INDEX IF NOT EXISTS idx_message_labels_account_label
  ON message_labels (account_id, label_id);

CREATE INDEX IF NOT EXISTS idx_outbox_account_status_id
  ON outbox (account_id, status, id);

-- Full text search over subject + body. `messages` keeps its default rowid
-- (it is not a WITHOUT ROWID table despite the composite PRIMARY KEY), so
-- the fts index can piggyback on it via content_rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  body_text,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
  INSERT INTO messages_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;
