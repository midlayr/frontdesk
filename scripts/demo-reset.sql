-- Reset Dumont's ticket data and load demo scenarios.
--
-- Run the whole file in the Neon SQL editor. Select nothing first — if any text is
-- highlighted, Neon runs only that fragment, which is a quiet way to half-apply this.
--
-- Deletes every lead, message, contact and company for the tenant. Keeps orgs, users,
-- sessions, chat_flows, sequences, counters — the app needs those to run.
--
-- Written as separate statements rather than one DO block so each step reports its own row
-- count. An earlier version hid the wipe inside a block and then read the result back in a
-- statement where app.org_id was no longer set, so a successful load looked like a failure.

-- ── 1. pin the tenant for the whole session ─────────────────────────────
-- 'false' means session-level, not transaction-local: every statement below, and anything
-- you run afterwards in this editor tab, sees it. With RLS forced on these tables, a
-- statement without it silently matches zero rows instead of erroring.
SELECT set_config('app.org_id', (SELECT id FROM orgs WHERE slug = 'dumont'), false) AS org_pinned;

-- ── 2. what is there now ────────────────────────────────────────────────
SELECT 'BEFORE' AS when_, (SELECT count(*) FROM leads) AS leads,
       (SELECT count(*) FROM messages) AS messages,
       (SELECT count(*) FROM contacts) AS contacts,
       (SELECT count(*) FROM companies) AS companies;

-- ── 3. wipe · children first, or the foreign keys refuse ────────────────
DELETE FROM activity;
DELETE FROM attachments;
DELETE FROM messages;
DELETE FROM enrollments;
DELETE FROM chat_sessions;
DELETE FROM leads;
DELETE FROM contacts;
DELETE FROM companies;

SELECT 'AFTER WIPE' AS when_, (SELECT count(*) FROM leads) AS leads,
       (SELECT count(*) FROM messages) AS messages;

-- ── 4. seed ─────────────────────────────────────────────────────────────
-- A block here because it needs the org id, an assignee and nine ticket numbers as
-- variables. Everything it writes is visible to step 5 below.
DO $$
DECLARE
  v_org  text;
  v_user text;
  v_base int;
  t      text;
BEGIN
  SELECT id INTO v_org FROM orgs WHERE slug = 'dumont';
  IF v_org IS NULL THEN RAISE EXCEPTION 'no org with slug dumont'; END IF;

  t := coalesce(nullif(brand->>'ticket_prefix',''), 'DL') FROM orgs WHERE id = v_org;

  SELECT id INTO v_user FROM users
   WHERE org_id = v_org AND disabled_at IS NULL
   ORDER BY (role = 'admin') DESC, created_at LIMIT 1;

  -- Continue the real counter rather than resetting it: an old ticket number may be sitting
  -- in somebody's inbox, and reissuing one would give two jobs the same reference.
  UPDATE counters SET next_ticket = next_ticket + 9
   WHERE org_id = v_org RETURNING next_ticket - 9 INTO v_base;
  IF v_base IS NULL THEN RAISE EXCEPTION 'no counters row for org %', v_org; END IF;

  -- Addresses are .test and numbers are in the 555-01xx fictional range. Both are reserved
  -- and unroutable, so hitting Send on a demo ticket cannot reach a real person.
  INSERT INTO companies (id, org_id, name, domain, industry, size_band,
                         lifetime_value, last_order_at, reorder_interval_days,
                         reorder_interval_source, radar) VALUES
   ('demo_abc',     v_org, 'ABC Plastics',         'abcplastics.test', 'Manufacturing', '50-200', 6720.00, now() - interval '82 days',  88,  'learned', 'reorder_due'),
   ('demo_harbor',  v_org, 'Harbor Point Dental',  'harborpoint.test', 'Healthcare',    '1-10',    950.00, now() - interval '210 days', NULL, NULL,     'lapsed'),
   ('demo_cascade', v_org, 'Cascade Brewing',      'cascadebrew.test', 'Food & Bev',    '11-50',  4200.00, now() - interval '45 days',  120, 'learned', NULL),
   ('demo_ridge',   v_org, 'Ridgeline Outfitters', 'ridgeline.test',   'Retail',        '11-50',     0.00, NULL, NULL, NULL, NULL);

  INSERT INTO contacts (id, org_id, company_id, name, email, phone, source) VALUES
   ('demo_dana',   v_org, 'demo_abc',     'Dana Whitfield', 'dana@abcplastics.test',   '+15595550142', 'inbound'),
   ('demo_priya',  v_org, 'demo_harbor',  'Priya Raman',    'priya@harborpoint.test',  '+15595550178', 'inbound'),
   ('demo_marcus', v_org, 'demo_cascade', 'Marcus Boone',   'marcus@cascadebrew.test', '+15595550193', 'inbound'),
   ('demo_sam',    v_org, 'demo_ridge',   'Sam Ellery',     'sam@ridgeline.test',      '+15595550111', 'inbound');

  -- Three won jobs ~88 days apart, so the reorder radar learns a rhythm instead of
  -- extrapolating from a single order, which it is designed not to do.
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status,
                     product, qty, size, stock, finish, quote_amount, quoted_at, won_at,
                     created_at, updated_at) VALUES
   ('demo_h1', v_org, t||'-'||(v_base+0), 'demo_dana', 'demo_abc', 'email', 'won', 'Warehouse labels', 5000, '4x6in', 'Vinyl, white', 'Matte', 2100.00, now() - interval '262 days', now() - interval '258 days', now() - interval '265 days', now() - interval '258 days'),
   ('demo_h2', v_org, t||'-'||(v_base+1), 'demo_dana', 'demo_abc', 'email', 'won', 'Warehouse labels', 5000, '4x6in', 'Vinyl, white', 'Matte', 2100.00, now() - interval '174 days', now() - interval '170 days', now() - interval '177 days', now() - interval '170 days'),
   ('demo_h3', v_org, t||'-'||(v_base+2), 'demo_dana', 'demo_abc', 'sms',   'won', 'Warehouse labels', 6000, '4x6in', 'Vinyl, white', 'Matte', 2520.00, now() - interval '86 days',  now() - interval '82 days',  now() - interval '89 days',  now() - interval '82 days');

  -- 1 · voicemail → structured ticket, one field it could not work out
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, deadline_at, product, qty, size, stock, finish, spec, confidence,
                     missing_fields, intent_score, created_at, updated_at)
  VALUES ('demo_l1', v_org, t||'-'||(v_base+3), 'demo_dana', 'demo_abc', 'voice', 'needs_info', NULL,
          false, now() + interval '9 days', 'Warehouse labels', 6000, '4x6in', NULL, 'Matte',
          '{"notes":"Same as the last run — needs the stock confirmed before quoting"}'::jsonb,
          '{"product":0.94,"qty":0.88,"size":0.91,"finish":0.62}'::jsonb,
          ARRAY['stock'], 78, now() - interval '3 hours', now() - interval '3 hours');

  -- 2 · email enquiry with artwork
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, deadline_at, product, qty, size, stock, color, finish, spec,
                     confidence, missing_fields, intent_score, created_at, updated_at)
  VALUES ('demo_l2', v_org, t||'-'||(v_base+4), 'demo_priya', 'demo_harbor', 'email', 'new', NULL,
          false, now() + interval '14 days', 'Appointment cards', 2500, '3.5x2in', '16pt C2S',
          'Full colour 4/4', 'Gloss',
          '{"notes":"Artwork attached. Wants a printed proof before the full run."}'::jsonb,
          '{"product":0.97,"qty":0.95,"size":0.93,"stock":0.81}'::jsonb,
          ARRAY[]::text[], 64, now() - interval '1 day', now() - interval '1 day');

  -- 3 · rush job from website chat, already picked up
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, deadline_at, product, qty, size, stock, color, spec, confidence,
                     missing_fields, intent_score, first_reply_at, created_at, updated_at)
  VALUES ('demo_l3', v_org, t||'-'||(v_base+5), 'demo_sam', 'demo_ridge', 'chat', 'replied', v_user,
          true, now() + interval '4 days', 'Trail map posters', 300, '18x24in', '100lb gloss text',
          'Full colour 4/0',
          '{"notes":"Event on the 4th — hard deadline"}'::jsonb,
          '{"product":0.92,"qty":0.9,"size":0.95}'::jsonb,
          ARRAY['finish'], 71, now() - interval '2 hours', now() - interval '5 hours', now() - interval '2 hours');

  -- 4 · text reorder, quoted, sitting in the pipeline with a value
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, deadline_at, product, qty, size, stock, color, finish, spec,
                     confidence, missing_fields, intent_score, quote_amount, quoted_at,
                     first_reply_at, created_at, updated_at)
  VALUES ('demo_l4', v_org, t||'-'||(v_base+6), 'demo_marcus', 'demo_cascade', 'sms', 'quoted', v_user,
          false, now() + interval '21 days', 'Can labels', 20000, '4.1x3.5in', 'BOPP, clear',
          '4 colour', 'Gloss',
          '{"notes":"Seasonal release — same artwork as spring"}'::jsonb,
          '{"product":0.96,"qty":0.99,"stock":0.88}'::jsonb,
          ARRAY[]::text[], 85, 3180.00, now() - interval '9 days',
          now() - interval '9 days', now() - interval '12 days', now() - interval '9 days');

  -- 5 · quoted and gone quiet — what a follow-up campaign is for
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, product, qty, size, stock, color, finish, spec, confidence,
                     missing_fields, intent_score, quote_amount, quoted_at, first_reply_at,
                     created_at, updated_at)
  VALUES ('demo_l5', v_org, t||'-'||(v_base+7), 'demo_priya', 'demo_harbor', 'email', 'quoted', v_user,
          false, 'Recall postcards', 1000, '6x4in', '14pt C1S', 'Full colour 4/1', 'Uncoated',
          '{"notes":"Quoted nine days ago, no reply since"}'::jsonb,
          '{"product":0.9,"qty":0.94}'::jsonb,
          ARRAY[]::text[], 52, 640.00, now() - interval '9 days', now() - interval '9 days',
          now() - interval '11 days', now() - interval '9 days');

  -- 6 · just landed, nobody has touched it
  INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id,
                     rush, product, qty, spec, confidence, missing_fields, intent_score,
                     created_at, updated_at)
  VALUES ('demo_l6', v_org, t||'-'||(v_base+8), 'demo_marcus', 'demo_cascade', 'voice', 'new', NULL,
          false, 'Tap handle decals', 150,
          '{"notes":"Wants to match the can label stock"}'::jsonb,
          '{"product":0.86,"qty":0.79}'::jsonb,
          ARRAY['size','stock'], 58, now() - interval '18 minutes', now() - interval '18 minutes');

  -- The two voicemails point at real audio already uploaded to R2, and the words below are
  -- what that audio actually says.
  INSERT INTO messages (id, lead_id, channel, direction, author, body, audio_r2_key,
                        transcript_status, provider_id, sent_at) VALUES
   ('demo_m1', 'demo_l1', 'voice', 'in', 'visitor',
    'Hi, this is Dana over at ABC Plastics. We need another run of the warehouse labels — about six thousand this time, four by six, same matte finish as always. I''m not certain we want the same stock, so give me a call back and we''ll sort it out. Thanks.',
    'org/'||v_org||'/voicemail/demo_m1.mp3', 'done', 'demo_CA1', now() - interval '3 hours'),
   ('demo_m2', 'demo_l2', 'email', 'in', 'visitor',
    E'Hello,\n\nCould we get a quote for 2,500 appointment cards? 3.5 x 2in, 16pt gloss, full colour both sides. Artwork is attached.\n\nWe would want a printed proof before the full run.\n\nThanks,\nPriya Raman\nHarbor Point Dental',
    NULL, NULL, '<demo-priya-1@harborpoint.test>', now() - interval '1 day'),
   ('demo_m3', 'demo_l3', 'chat', 'in', 'visitor',
    'Do you handle large format? We need about 300 trail maps, 18x24, for an event on the 4th.',
    NULL, NULL, NULL, now() - interval '5 hours'),
   ('demo_m4', 'demo_l3', 'chat', 'out', v_user,
    'We do — 300 at 18x24 on 100lb gloss text is comfortable for the 4th as long as artwork reaches us by Friday. Matte or gloss finish?',
    NULL, NULL, NULL, now() - interval '2 hours'),
   ('demo_m5', 'demo_l4', 'sms', 'in', 'visitor',
    'Hey — need to reorder the can labels for the seasonal release. 20k, same artwork as spring. How fast can you turn those around?',
    NULL, NULL, 'demo_SM1', now() - interval '12 days'),
   ('demo_m6', 'demo_l4', 'sms', 'out', v_user,
    'Hi Marcus — 20,000 can labels on clear BOPP, gloss, comes to $3,180. Ten working days from artwork approval. Want me to book it in?',
    NULL, NULL, 'demo_SM2', now() - interval '9 days'),
   ('demo_m7', 'demo_l5', 'email', 'in', 'visitor',
    'Following up on the recall postcards — could you send pricing for 1,000?',
    NULL, NULL, '<demo-priya-2@harborpoint.test>', now() - interval '11 days'),
   ('demo_m8', 'demo_l5', 'email', 'out', v_user,
    E'Hi Priya,\n\n1,000 recall postcards, 6x4in on 14pt C1S, full colour one side: $640 including delivery.\n\nHappy to get it on the press whenever you are.\n\nDumont Printing',
    NULL, NULL, '<demo-dumont-1@midlayr.com>', now() - interval '9 days'),
   ('demo_m9', 'demo_l6', 'voice', 'in', 'visitor',
    'Morning — Marcus at Cascade. We''re after about a hundred and fifty tap handle decals, ideally matching the stock you used on the can labels. Give me a shout when you get a chance.',
    'org/'||v_org||'/voicemail/demo_m9.mp3', 'done', 'demo_CA2', now() - interval '18 minutes');

  INSERT INTO activity (id, org_id, lead_id, actor, kind, detail, at) VALUES
   ('demo_a1', v_org, 'demo_l1', 'system', 'lead_created',       '{"channel":"voice"}'::jsonb,           now() - interval '3 hours'),
   ('demo_a2', v_org, 'demo_l1', 'system', 'voicemail_received', '{"seconds":15}'::jsonb,                now() - interval '3 hours'),
   ('demo_a3', v_org, 'demo_l1', 'system', 'specs_extracted',    '{"missing":["stock"]}'::jsonb,         now() - interval '3 hours'),
   ('demo_a4', v_org, 'demo_l2', 'system', 'lead_created',       '{"channel":"email"}'::jsonb,           now() - interval '1 day'),
   ('demo_a5', v_org, 'demo_l3', v_user,   'stage',              '{"from":"new","to":"replied"}'::jsonb, now() - interval '2 hours'),
   ('demo_a6', v_org, 'demo_l4', v_user,   'stage',              '{"from":"new","to":"quoted"}'::jsonb,  now() - interval '9 days'),
   ('demo_a7', v_org, 'demo_l5', v_user,   'stage',              '{"from":"new","to":"quoted"}'::jsonb,  now() - interval '9 days'),
   ('demo_a8', v_org, 'demo_l6', 'system', 'lead_created',       '{"channel":"voice"}'::jsonb,           now() - interval '18 minutes');

  RAISE NOTICE 'seeded % tickets, owner %', 9, coalesce(v_user, '(unassigned)');
END $$;

-- ── 5. read it back ─────────────────────────────────────────────────────
-- Works because step 1 set app.org_id at session level. Nine rows means done.
SELECT ticket_no, channel, status, rush, product, qty, quote_amount,
       (SELECT name FROM companies c WHERE c.id = l.company_id) AS company
  FROM leads l ORDER BY created_at DESC;
