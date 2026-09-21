-- Pathfinder · quote value, company history, notes and tasks.
-- From scaffold v5's schema-pathfinder.sql, with RLS brought in line with the rest of the
-- schema: the scaffold enables it on notes and tasks but does not FORCE it, and without
-- FORCE the table owner bypasses its own policies — the same gap that made RLS inert on
-- every table in session 1.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS quoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS won_at timestamptz,
  ADD COLUMN IF NOT EXISTS lost_reason text,
  ADD COLUMN IF NOT EXISTS health jsonb NOT NULL DEFAULT '{}';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS lifetime_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_order_at timestamptz,
  ADD COLUMN IF NOT EXISTS reorder_interval_days integer,
  ADD COLUMN IF NOT EXISTS reorder_interval_source text
    CHECK (reorder_interval_source IN ('learned','manual')),
  ADD COLUMN IF NOT EXISTS radar text CHECK (radar IN ('reorder_due','lapsed','seasonal'));

CREATE TABLE IF NOT EXISTS notes (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  lead_id text REFERENCES leads(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id),
  audio_r2_key text, duration_s integer, transcript text,
  transcript_status text CHECK (transcript_status IN ('pending','done','failed')),
  extracted jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_lead ON notes (lead_id, created_at);
CREATE INDEX IF NOT EXISTS notes_company ON notes (company_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  lead_id text REFERENCES leads(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id),
  assignee_id text REFERENCES users(id), text text NOT NULL, due_at timestamptz,
  source text NOT NULL DEFAULT 'manual',
  done_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (org_id, assignee_id, due_at) WHERE done_at IS NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['notes','tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_setting(''app.org_id'', true))
                              WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      t || '_org', t);
  END LOOP;
END $$;
