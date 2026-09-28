-- Resetting a forgotten password, without an admin.
--
-- Until now the only ways back in were Settings → People (needs a working admin session) and
-- the platform operator token (needs a secret most people do not have to hand). Both fail in
-- the one case that matters: nobody can sign in.
--
-- Deliberately outside RLS, for the same reason sessions is: the token arrives from a link
-- and has to be looked up before any org context exists. Every row names its org, and the
-- confirm step checks that org against the hostname the request came in on, so a token
-- cannot be redeemed on another tenant.
CREATE TABLE IF NOT EXISTS password_resets (
  -- The PRIMARY KEY is the SHA-256 of the token, never the token. A leak of this table then
  -- grants nothing: the link in the mailbox is the only thing that can be redeemed, exactly
  -- as with password_hash.
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id);
-- Sweeping expired rows is a scan over this, run from the same cron as the drips.
CREATE INDEX IF NOT EXISTS password_resets_expiry ON password_resets (expires_at)
  WHERE used_at IS NULL;
