CREATE TABLE IF NOT EXISTS writing_profile_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  relationship_key TEXT NOT NULL,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_profile_exclusions (
  account_id INTEGER NOT NULL,
  exclusion_type TEXT NOT NULL,
  exclusion_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, exclusion_type, exclusion_value)
);
