-- Several ways to be the same person.
--
-- A password is one identity, not the definition of a user. Microsoft/Google OIDC and SAML
-- land here as additional rows, so adding SSO later is a new provider and a callback route
-- rather than a change to how sessions, users or permissions work. Retrofitting this after
-- the fact means touching every login path, so the shape goes in now even though only
-- 'password' is implemented.

CREATE TABLE IF NOT EXISTS user_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('password','google','microsoft','saml')),
  -- the provider's stable id for this person: 'sub' for OIDC, NameID for SAML,
  -- and the user id itself for 'password'
  subject text NOT NULL,
  email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities (user_id);

-- Which providers a tenant allows, and their SSO config. Lives on the org so one shop can
-- require Microsoft SSO while another stays on passwords.
--   { "password": true, "microsoft": { "tenant_id": "...", "client_id": "..." } }
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS auth jsonb NOT NULL DEFAULT '{"password":true}';

-- Backfill an identity row for anyone who already has a password.
INSERT INTO user_identities (id, user_id, org_id, provider, subject, email)
SELECT 'ident_' || u.id, u.id, u.org_id, 'password', u.id, u.email
  FROM users u
 WHERE u.password_hash IS NOT NULL
ON CONFLICT (provider, subject) DO NOTHING;
