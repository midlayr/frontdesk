-- Pathfinder additions · run after schema.sql
ALTER TABLE leads ADD COLUMN quote_amount numeric(10,2), ADD COLUMN quoted_at timestamptz, ADD COLUMN won_at timestamptz, ADD COLUMN lost_reason text;
ALTER TABLE companies ADD COLUMN lifetime_value numeric(12,2) NOT NULL DEFAULT 0, ADD COLUMN last_order_at timestamptz,
  ADD COLUMN reorder_interval_days integer, ADD COLUMN reorder_interval_source text CHECK (reorder_interval_source IN ('learned','manual')),
  ADD COLUMN radar text CHECK (radar IN ('reorder_due','lapsed','seasonal'));

CREATE TABLE notes (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  lead_id text REFERENCES leads(id) ON DELETE CASCADE, company_id text REFERENCES companies(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id),
  audio_r2_key text, duration_s integer, transcript text, transcript_status text CHECK (transcript_status IN ('pending','done','failed')),
  extracted jsonb,                           -- {specs:{finish:'gloss/matte'}, tasks:[{text,due}], interests:['EDDM']}
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_lead ON notes (lead_id, created_at); CREATE INDEX notes_company ON notes (company_id, created_at);

CREATE TABLE tasks (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id),
  lead_id text REFERENCES leads(id) ON DELETE CASCADE, company_id text REFERENCES companies(id),
  assignee_id text REFERENCES users(id), text text NOT NULL, due_at timestamptz,
  source text NOT NULL DEFAULT 'manual',    -- manual | note:<id> | radar
  done_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_open ON tasks (org_id, assignee_id, due_at) WHERE done_at IS NULL;

-- health score factors, recomputed by score_intent job; leads.intent_score = sum
-- companies.health / leads.confidence hold: {recency:0-20, deadline:0-20, value:0-20, reply_speed:0-20, repeat:0-20, fit:0-20, why:'…'}
ALTER TABLE leads ADD COLUMN health jsonb NOT NULL DEFAULT '{}';

ALTER TABLE notes ENABLE ROW LEVEL SECURITY; CREATE POLICY notes_org ON notes USING (org_id = current_setting('app.org_id', true));
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY; CREATE POLICY tasks_org ON tasks USING (org_id = current_setting('app.org_id', true));
