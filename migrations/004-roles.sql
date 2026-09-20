-- Users and roles.
--
-- 'rep' becomes 'sales'. Renaming the enum value rather than adding one keeps a single
-- vocabulary: no code reads users.role (the 'rep' that appears all over src/ is the chat
-- participant on a WebSocket, a different thing entirely), so there is nothing to migrate
-- beyond the label itself.
ALTER TYPE user_role RENAME VALUE 'rep' TO 'sales';

-- People leave. Seven foreign keys point at users — leads.assignee_id, activity actors,
-- chat_flows.updated_by, sessions and more — so a departing colleague cannot be deleted
-- without taking history with them. Disabling keeps the record and closes the door.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by text REFERENCES users(id);

CREATE INDEX IF NOT EXISTS users_active ON users (org_id) WHERE disabled_at IS NULL;
