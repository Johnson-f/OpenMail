ALTER TABLE messages ADD COLUMN message_id_header TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE attachments ADD COLUMN content_id TEXT;
ALTER TABLE attachments ADD COLUMN disposition TEXT NOT NULL DEFAULT 'attachment';
ALTER TABLE attachments ADD COLUMN inline_data TEXT;
