CREATE TABLE event_cursors (
  consumer TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO event_cursors (consumer, last_event_id, updated_at)
SELECT consumer, MAX(event_id), MAX(processed_at)
  FROM mail_event_consumers
 GROUP BY consumer;

DROP TABLE mail_event_consumers;
