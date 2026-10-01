CREATE TABLE IF NOT EXISTS local_drafts (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  gmail_draft_id TEXT,
  message_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_drafts_account
  ON local_drafts (account_id, updated_at);

CREATE TABLE IF NOT EXISTS send_ledger (
  operation_id TEXT PRIMARY KEY,
  action_intent_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  rfc_message_id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_ledger_status
  ON send_ledger (status, updated_at);
