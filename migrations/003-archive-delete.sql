-- Archiving and deleting tickets.

-- Archive is reversible and orthogonal to status: you archive a won job as much as a spam
-- one, so it is its own column rather than another lead_status value.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_by text REFERENCES users(id);
CREATE INDEX IF NOT EXISTS leads_active ON leads (org_id, archived_at) WHERE archived_at IS NULL;

-- Deleting a lead used to fail on these two: messages, attachments and activity cascade,
-- but chat_sessions and enrollments were NO ACTION, so any chat-sourced ticket was
-- undeletable. The session and enrolment survive with a null lead — they are records of
-- something that happened, not children of the ticket.
ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_lead_id_fkey;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_lead_id_fkey;
ALTER TABLE enrollments ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
