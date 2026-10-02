-- Single-use email tokens: signing in by link, and resetting a forgotten password.
--
-- One table, not three. A sign-in link, an invite and a reset link are the same object — a secret mailed to
-- an address, good once, for a short while — and differ only in what redeeming one does. Two
-- tables would mean two expiry sweeps, two hashing paths and two places to get wrong.
--
-- Outside RLS, like sessions: the token arrives from a link and is looked up before any org
-- context exists. Every row names its org and redeeming one checks that org against the
-- hostname, so a token minted for one tenant cannot be spent on another.
--
-- Supersedes the earlier 007-password-resets.sql, which was never applied anywhere.
DROP TABLE IF EXISTS password_resets;

CREATE TABLE IF NOT EXISTS auth_tokens (
  -- SHA-256 of the token, never the token. The link in the mailbox is the only redeemable
  -- copy, so this table leaking grants nothing — the same bargain as users.password_hash.
  token_hash text PRIMARY KEY,
  purpose    text NOT NULL CHECK (purpose IN ('login', 'invite', 'reset')),
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id, purpose);
-- The nightly sweep of expired, unredeemed rows reads this.
CREATE INDEX IF NOT EXISTS auth_tokens_expiry ON auth_tokens (expires_at) WHERE used_at IS NULL;
