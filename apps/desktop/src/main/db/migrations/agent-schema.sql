CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  account_scope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
  ON conversation_messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS action_intents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id INTEGER,
  arguments_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  initiator_json TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_intent_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_action
  ON audit_events (action_intent_id, id);

CREATE TABLE IF NOT EXISTS automation_versions (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  specification_json TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (automation_id, version)
);

CREATE TABLE IF NOT EXISTS automation_triggers (
  id TEXT PRIMARY KEY,
  automation_version_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL UNIQUE,
  due_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_triggers_due
  ON automation_triggers (status, due_at);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_version_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  lease_expires_at INTEGER,
  result_json TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_profiles (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  relationship_key TEXT,
  version INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_writing_profile_scope
  ON writing_profiles (account_id, relationship_key, version);
