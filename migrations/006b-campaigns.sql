-- Campaigns, part two. Separate file because a new enum value cannot be used in the same
-- transaction that adds it.

ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS trigger_config jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS send_window jsonb NOT NULL
    DEFAULT '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00","tz":"America/Los_Angeles"}',
  ADD COLUMN IF NOT EXISTS send_as text NOT NULL DEFAULT 'rep' CHECK (send_as IN ('rep','org'));
-- trigger values: lead_created · quoted_no_reply · reorder_due · lapsed · list · manual

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'email'
    CHECK (kind IN ('email','sms','wait','task')),
  ADD COLUMN IF NOT EXISTS attach_quote boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS branches jsonb NOT NULL DEFAULT '[]';
-- branches: [{if, value?, then, config?}] — first is always {if:'replied',then:'stop'}

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS held_reason text,
  ADD COLUMN IF NOT EXISTS current_step_id text REFERENCES sequence_steps(id),
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz,
  -- Which message the stop-on-reply check measures from. Without it, "any inbound since
  -- enrollment" re-fires on a conversation that was already replying before it started.
  ADD COLUMN IF NOT EXISTS started_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrollment_id text REFERENCES enrollments(id),
  ADD COLUMN IF NOT EXISTS step_id text REFERENCES sequence_steps(id);
CREATE INDEX IF NOT EXISTS messages_enrollment ON messages (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

-- 2. `window` is a reserved word and will not parse unquoted. Renamed rather than quoted:
--    a quoted column has to stay quoted in every query anyone writes afterwards.
-- 3. step_id null means "the whole sequence", but the scaffold puts it in the primary key,
--    which makes Postgres mark it NOT NULL — so the rows step 7 exists to write could never
--    be inserted. A surrogate key plus a COALESCE unique index keeps both properties.
CREATE TABLE IF NOT EXISTS sequence_stats (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  sequence_id text NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_id text REFERENCES sequence_steps(id) ON DELETE CASCADE,   -- null = whole sequence
  span text NOT NULL CHECK (span IN ('30d','90d','all')),
  enrolled integer NOT NULL DEFAULT 0, sent integer NOT NULL DEFAULT 0,
  opened integer NOT NULL DEFAULT 0, clicked integer NOT NULL DEFAULT 0,
  replied integer NOT NULL DEFAULT 0, won integer NOT NULL DEFAULT 0,
  revenue numeric(12,2) NOT NULL DEFAULT 0,
  read text,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sequence_stats_key
  ON sequence_stats (sequence_id, COALESCE(step_id, ''), span);

-- enrollments and sequence_steps reach their org through a parent; sequence_stats carries
-- org_id so it is scoped the same way as every other top-level table.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sequence_stats'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = current_setting(''app.org_id'', true))
                             WITH CHECK (org_id = current_setting(''app.org_id'', true))',
      t || '_org', t);
  END LOOP;
END $$;
