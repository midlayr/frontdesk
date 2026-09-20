-- Dumont Front Desk · Postgres schema · v0.1
-- Target: Neon / Supabase behind Cloudflare Hyperdrive. Run: psql $DATABASE_URL -f scaffold/schema.sql
-- Invariants: every query scoped by org_id · IDs are ULIDs (text) · all DB access through one db() adapter.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;   -- users.email, contacts.email, platform_users.email

CREATE TYPE user_role     AS ENUM ('sales','admin');
CREATE TYPE channel       AS ENUM ('voice','sms','email','form','chat');
CREATE TYPE lead_status   AS ENUM ('live','new','needs_info','replied','quoted','won','lost','closed','spam');
CREATE TYPE msg_direction AS ENUM ('in','out');
CREATE TYPE chat_state    AS ENUM ('bot','live','done','abandoned');
CREATE TYPE seq_channel   AS ENUM ('sms','email');
CREATE TYPE enroll_state  AS ENUM ('active','paused','replied','completed','opted_out');
CREATE TYPE import_status AS ENUM ('pending','mapping','enriching','done','failed');

-- ── tenancy · Midlayr is the platform, each print shop (Dumont) is an org ──
CREATE TABLE orgs (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE,   -- 'dumont' → dumont.midlayr.app by default
  name text NOT NULL,                       -- legal / display name
  plan text NOT NULL DEFAULT 'retainer',    -- retainer | fixed | trial | internal
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','churned')),
  -- white label: everything the tenant's reps and customers see
  brand jsonb NOT NULL DEFAULT '{}',        -- {app_name:'Dumont Front Desk', color:'#0B7FA8', ink, paper, logo_r2_key, favicon_r2_key, wordmark, show_powered_by:true}
  comms jsonb NOT NULL DEFAULT '{}',        -- {email_from:'quotes@dumontprinting.com', email_domain_verified, sms_number, voice_number, signature, footer}
  widget jsonb NOT NULL DEFAULT '{}',       -- {launcher, nudge, allowed_domains[], position}
  hours jsonb NOT NULL DEFAULT '{}',        -- {tz, mon:[..], ...}
  features jsonb NOT NULL DEFAULT '{}',     -- {chat:true, pathfinder:false, drip:true, imports:false} per-tenant flags
  created_at timestamptz NOT NULL DEFAULT now()
);
-- custom hostnames (Cloudflare for SaaS) → org. frontdesk.dumontprinting.com, chat widget origin, etc.
CREATE TABLE org_domains (
  hostname text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('app','widget','email')),
  verified_at timestamptz, cf_custom_hostname_id text
);
CREATE INDEX org_domains_org ON org_domains (org_id);
-- Midlayr staff: cross-tenant access, never rows in a tenant's users table
CREATE TABLE platform_users (
  id text PRIMARY KEY, email citext NOT NULL UNIQUE, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','support','engineer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  email citext NOT NULL UNIQUE, name text NOT NULL, role user_role NOT NULL,
  -- Never deleted: seven tables reference a user, so removing one would take the ticket
  -- history with it. Disabling ends the sessions and blocks the login instead.
  disabled_at timestamptz, invited_by text REFERENCES users(id),
  last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_active ON users (org_id) WHERE disabled_at IS NULL;

-- ── people & companies (Pathfinder / enrichment) ────────
CREATE TABLE companies (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL, domain text, industry text, size_band text,
  enrichment jsonb, enriched_at timestamptz,
  health_score smallint CHECK (health_score BETWEEN 0 AND 100), health jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE TABLE contacts (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  company_id text REFERENCES companies(id),
  name text, email citext, phone text,
  opted_out boolean NOT NULL DEFAULT false, opted_out_at timestamptz,
  source text,                              -- 'inbound' | 'import:<list_id>'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_phone ON contacts (org_id, phone);
CREATE INDEX contacts_email ON contacts (org_id, email);

-- ── the queue: one row per job ticket ───────────────────
CREATE TABLE leads (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  ticket_no text NOT NULL,                  -- 'DL-2046'
  contact_id text REFERENCES contacts(id),
  company_id text REFERENCES companies(id),
  channel channel NOT NULL,
  status lead_status NOT NULL DEFAULT 'new',
  assignee_id text REFERENCES users(id),
  rush boolean NOT NULL DEFAULT false,
  deadline_at timestamptz,
  product text, qty integer, size text, stock text, color text, finish text,
  spec jsonb NOT NULL DEFAULT '{}',         -- long-tail fields + notes
  confidence jsonb NOT NULL DEFAULT '{}',   -- {"qty":0.92,"stock":0.41} → dashed chips
  missing_fields text[] NOT NULL DEFAULT '{}',
  intent_score smallint CHECK (intent_score BETWEEN 0 AND 100),
  first_reply_at timestamptz,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(product,'') || ' ' || coalesce(stock,'') || ' ' || coalesce(spec->>'notes',''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, ticket_no)
);
CREATE INDEX leads_queue    ON leads (org_id, status, rush DESC, deadline_at NULLS LAST, created_at);
CREATE INDEX leads_assignee ON leads (org_id, assignee_id, status);
CREATE INDEX leads_search   ON leads USING gin (search);

-- ── every message on every channel ──────────────────────
CREATE TABLE messages (
  id text PRIMARY KEY, lead_id text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel channel NOT NULL, direction msg_direction NOT NULL,
  author text NOT NULL,                     -- 'visitor' | 'bot' | user_id
  body text, raw jsonb,
  audio_r2_key text, transcript_status text CHECK (transcript_status IN ('pending','done','failed')),
  provider_id text,                         -- Twilio SID / Message-ID
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_lead ON messages (lead_id, sent_at);
CREATE UNIQUE INDEX messages_provider ON messages (provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE attachments (
  id text PRIMARY KEY, lead_id text NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  message_id text REFERENCES messages(id),
  r2_key text NOT NULL, filename text NOT NULL, mime text, bytes bigint,
  preflight jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Midlayr Chat ────────────────────────────────────────
CREATE TABLE chat_flows (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  slug text NOT NULL, name text NOT NULL,
  steps jsonb NOT NULL,                     -- [{kind:'ask'|'rule'|'ticket', ...}]
  settings jsonb NOT NULL DEFAULT '{}',     -- {launcher, nudge, domains[], position}
  version integer NOT NULL DEFAULT 1, published_at timestamptz,
  updated_by text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE TABLE chat_sessions (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  flow_id text NOT NULL REFERENCES chat_flows(id), flow_version integer NOT NULL,
  lead_id text REFERENCES leads(id),
  visitor_id text NOT NULL,
  step_idx integer NOT NULL DEFAULT 0,
  state chat_state NOT NULL DEFAULT 'bot',
  rep_id text REFERENCES users(id),
  visitor jsonb NOT NULL DEFAULT '{}',      -- {referrer, landing, utm, ua, geo, returning}
  captured jsonb NOT NULL DEFAULT '{}',
  do_id text,                               -- Durable Object holding the live socket
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE INDEX chat_sessions_open ON chat_sessions (org_id, state, started_at);

-- ── drip / nurture ──────────────────────────────────────
CREATE TABLE sequences (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL, trigger text NOT NULL,  -- lead_created | quoted_no_reply_24h | reorder_90d | manual
  channel seq_channel NOT NULL, active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sequence_steps (
  id text PRIMARY KEY, sequence_id text NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position integer NOT NULL, delay interval NOT NULL,
  subject text, body text NOT NULL,         -- tokens: {first_name} {qty} {product} {ticket_no}
  UNIQUE (sequence_id, position)
);
CREATE TABLE enrollments (
  id text PRIMARY KEY, sequence_id text NOT NULL REFERENCES sequences(id),
  lead_id text NOT NULL REFERENCES leads(id), contact_id text NOT NULL REFERENCES contacts(id),
  next_step integer NOT NULL DEFAULT 1, next_send_at timestamptz,
  state enroll_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrollments_due ON enrollments (next_send_at) WHERE state = 'active';

-- ── list upload + enrichment ────────────────────────────
CREATE TABLE list_imports (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  filename text NOT NULL, r2_key text NOT NULL, uploaded_by text REFERENCES users(id),
  rows_total integer, rows_ok integer, rows_dupe integer, rows_failed integer,
  mapping jsonb, status import_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── audit (partition by month once it grows) ────────────
CREATE TABLE activity (
  id text PRIMARY KEY, org_id text NOT NULL, lead_id text REFERENCES leads(id) ON DELETE CASCADE,
  actor text NOT NULL, kind text NOT NULL, detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_lead ON activity (lead_id, at);

CREATE TABLE counters (org_id text PRIMARY KEY REFERENCES orgs(id), next_ticket integer NOT NULL DEFAULT 2000);

-- ── housekeeping ────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER leads_touch BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Row-level security ──────────────────────────────────
-- The Worker runs `SET LOCAL app.org_id = '…'` inside a transaction (see src/db.ts withOrg()).
-- current_setting(..., true) returns NULL when unset, and `org_id = NULL` matches no rows,
-- so a query that forgets to set the org context fails closed rather than leaking across tenants.
--
-- FORCE is load-bearing: Neon connects as the role that owns these tables, and a table owner
-- bypasses its own RLS policies unless forced. Without FORCE every policy below is inert.
--
-- orgs / org_domains / platform_users are deliberately NOT under RLS: tenant resolution reads
-- them before an org context exists.

-- direct org_id column
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','companies','contacts','leads','chat_flows','chat_sessions',
                           'sequences','list_imports','activity','counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_setting(''app.org_id'', true))
                             WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      t || '_org', t);
  END LOOP;
END $$;

-- scoped through leads
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','attachments','enrollments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = %I.lead_id))
                             WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = %I.lead_id))',
      t || '_org', t, t, t);
  END LOOP;
END $$;

-- scoped through sequences
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sequence_steps_org ON sequence_steps;
CREATE POLICY sequence_steps_org ON sequence_steps
  USING      (EXISTS (SELECT 1 FROM sequences s WHERE s.id = sequence_steps.sequence_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sequences s WHERE s.id = sequence_steps.sequence_id));
