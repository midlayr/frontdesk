-- Dumont's seven sales reps, as routing targets.
--
-- Added as people the bot can hand a job to, NOT as logins: no password, no invite, nothing
-- sent to any of them. They show on the Team page as "Not invited · can be assigned work",
-- and the moment somebody wants an account you press Invite on that row — the record is
-- already there, with their history attached. Nothing to migrate, nothing keyed twice.
--
-- Role is 'sales' rather than 'admin': owning tickets needs nothing more, and admin would
-- hand seven people the ability to pause the live bot and rewrite the shop's settings.
--
-- Names must match the chips in the flow's "Who is your account rep?" question. The matcher
-- is forgiving about case, spacing and punctuation but will not guess at a near miss, so
-- use the builder's "Fill from team" button rather than retyping them.
--
-- Safe to run more than once: email is unique, and a second run changes nothing.

INSERT INTO users (id, org_id, email, name, role)
SELECT
  -- Deterministic, so a re-run collides on the unique email rather than inserting twins.
  'usr_' || substr(md5(v.email), 1, 22),
  o.id, v.email, v.name, 'sales'::user_role
FROM orgs o
CROSS JOIN (VALUES
  ('susanm@dumontprinting.com',  'Susan Moore'),
  ('seanw@dumontprinting.com',   'Sean Wheelock'),
  ('jeffr@dumontprinting.com',   'Jeff Renn'),
  ('gayleg@dumontprinting.com',  'Gayle Takakjian-Gilbert'),
  ('amandan@dumontprinting.com', 'Amanda Nicassio'),
  ('lloydp@dumontprinting.com',  'Lloyd Paine'),
  ('wadec@dumontprinting.com',   'Wade Cox')
) AS v(email, name)
WHERE o.slug = 'dumont'
ON CONFLICT (email) DO NOTHING;

-- What you should see: seven rows, every one "Not invited".
SELECT u.name, u.email, u.role,
       CASE WHEN u.disabled_at IS NOT NULL THEN 'Disabled'
            WHEN u.last_seen_at IS NOT NULL THEN 'Active'
            WHEN u.password_set_at IS NOT NULL THEN 'Never signed in'
            WHEN u.invited_at IS NULL THEN 'Not invited'
            ELSE 'Invited' END AS state
  FROM users u JOIN orgs o ON o.id = u.org_id
 WHERE o.slug = 'dumont'
 ORDER BY u.role, u.name;
