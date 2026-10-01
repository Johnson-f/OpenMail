ALTER TABLE accounts ADD COLUMN sync_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN seen_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_account_epoch
  ON messages (account_id, seen_epoch);

UPDATE accounts
   SET message_count = (SELECT COUNT(*) FROM messages m WHERE m.account_id = accounts.id);

CREATE TRIGGER IF NOT EXISTS messages_count_ai AFTER INSERT ON messages BEGIN
  UPDATE accounts SET message_count = message_count + 1 WHERE id = new.account_id;
END;

CREATE TRIGGER IF NOT EXISTS messages_count_ad AFTER DELETE ON messages BEGIN
  UPDATE accounts SET message_count = message_count - 1 WHERE id = old.account_id;
END;
