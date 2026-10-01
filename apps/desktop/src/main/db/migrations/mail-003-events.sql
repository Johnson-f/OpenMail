CREATE TABLE IF NOT EXISTS mail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  history_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_events_account_id
  ON mail_events (account_id, id);

CREATE TABLE IF NOT EXISTS mail_event_consumers (
  consumer TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS sync_errors (
  account_id INTEGER PRIMARY KEY,
  message TEXT NOT NULL,
  error_kind TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
