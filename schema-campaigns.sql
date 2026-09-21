-- Campaigns additions · run after schema.sql (+ schema-pathfinder.sql)
ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_trigger_check;
ALTER TABLE sequences ADD COLUMN trigger_config jsonb NOT NULL DEFAULT '{}',   -- {days:2} | {list_id} | {}
  ADD COLUMN send_window jsonb NOT NULL DEFAULT '{"days":[1,2,3,4,5],"start":"08:00","end":"17:00"}',
  ADD COLUMN send_as text NOT NULL DEFAULT 'rep' CHECK (send_as IN ('rep','org'));
-- trigger values: lead_created · quoted_no_reply · reorder_due · lapsed · list · manual

ALTER TABLE sequence_steps ADD COLUMN kind text NOT NULL DEFAULT 'email' CHECK (kind IN ('email','sms','wait','task')),
  ADD COLUMN attach_quote boolean NOT NULL DEFAULT false,
  ADD COLUMN branches jsonb NOT NULL DEFAULT '[]';
-- branches: [{if:'replied'|'opened_no_reply'|'not_opened'|'clicked'|'bounced'|'sms_delivered'|'health_below', value?:int,
--             then:'continue'|'stop'|'resend'|'skip_to'|'switch_sms'|'assign'|'task'|'tag', config?:{subject?,step?,user_id?,text?,tag?}}]
-- first branch is always {if:'replied', then:'stop'} — enforced in API, not editable.

ALTER TABLE enrollments ADD COLUMN held_reason text,             -- 'missing:{qty}' etc.
  ADD COLUMN current_step_id text REFERENCES sequence_steps(id),
  ADD COLUMN last_sent_at timestamptz;
ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_state_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_state_check CHECK (state IN ('active','held','paused','replied','completed','opted_out','removed'));

-- delivery events from Resend / Twilio webhooks
ALTER TABLE messages ADD COLUMN delivered_at timestamptz, ADD COLUMN opened_at timestamptz, ADD COLUMN clicked_at timestamptz, ADD COLUMN bounced_at timestamptz,
  ADD COLUMN enrollment_id text REFERENCES enrollments(id), ADD COLUMN step_id text REFERENCES sequence_steps(id);
CREATE INDEX messages_enrollment ON messages (enrollment_id) WHERE enrollment_id IS NOT NULL;

-- nightly rollup for 1e
CREATE TABLE sequence_stats (
  sequence_id text NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_id text REFERENCES sequence_steps(id) ON DELETE CASCADE,   -- null = whole sequence
  window text NOT NULL CHECK (window IN ('30d','90d','all')),
  enrolled integer NOT NULL DEFAULT 0, sent integer NOT NULL DEFAULT 0, opened integer NOT NULL DEFAULT 0, clicked integer NOT NULL DEFAULT 0,
  replied integer NOT NULL DEFAULT 0, won integer NOT NULL DEFAULT 0, revenue numeric(12,2) NOT NULL DEFAULT 0,
  read text,                                                       -- one-sentence LLM summary
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sequence_id, step_id, window)
);
