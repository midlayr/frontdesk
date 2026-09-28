-- Deal Flow · run after schema.sql + schema-pathfinder.sql
-- v1: six fixed stage ids that map 1:1 to lead_status (new, needs_info, replied, quoted, won, lost).
-- Tenants can rename stages, set time limits, automations and exit paths. Adding brand-new stages is v2.
CREATE TABLE deal_flows (
  id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id) UNIQUE,
  draft jsonb NOT NULL,                  -- [{id:'new',name:'New',enter:'…',sla:{on,hours,then},actions:[{kind,on,value}],exits:[{to,when}]}]
  published jsonb,                       -- same shape; what the engine runs
  version integer NOT NULL DEFAULT 0, published_at timestamptz,
  updated_by text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE deal_flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY deal_flows_org ON deal_flows USING (org_id = current_setting('app.org_id', true));

-- stage entry time drives time limits
ALTER TABLE leads ADD COLUMN stage_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sla_breached_at timestamptz,
  ADD COLUMN deal_flow_version integer;
CREATE INDEX leads_sla ON leads (org_id, status, stage_entered_at) WHERE sla_breached_at IS NULL;
