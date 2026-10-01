CREATE TABLE IF NOT EXISTS indexed_messages (
  generation_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, account_id, message_id)
);

ALTER TABLE index_generations ADD COLUMN seed_until_event_id INTEGER;
