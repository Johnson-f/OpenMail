ALTER TABLE automation_triggers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_triggers ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automation_triggers ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_automation_triggers_available
  ON automation_triggers (status, available_at, due_at);
