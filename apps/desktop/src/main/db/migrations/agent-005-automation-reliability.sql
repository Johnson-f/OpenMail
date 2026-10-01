ALTER TABLE automation_versions ADD COLUMN schedule_cursor INTEGER;

CREATE TABLE IF NOT EXISTS automation_run_steps (
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_index)
);
