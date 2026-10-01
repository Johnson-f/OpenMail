CREATE TABLE IF NOT EXISTS automation_simulations (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  specification_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_simulations_version
  ON automation_simulations (automation_id, version, created_at);
