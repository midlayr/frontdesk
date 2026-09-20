-- Real user sessions, replacing the operator token as the way a person signs in.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;

-- users.email is globally UNIQUE, so login has to find the user before an org context
-- exists — which is also why this table sits outside RLS, like orgs and org_domains.
CREATE TABLE IF NOT EXISTS sessions (
  -- sha256 of the cookie token, never the token itself: a leaked database read does not
  -- hand over live sessions.
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip text
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
