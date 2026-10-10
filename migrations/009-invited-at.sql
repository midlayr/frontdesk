-- When a colleague was last sent a sign-in link.
--
-- The Team page had four states and no way to tell two of them apart. A person created as a
-- routing target — a sales rep the bot can hand a job to, who has never been asked to log in
-- — showed as "Invited · waiting on them to open their link", which is simply untrue: no
-- link was ever sent. invited_by does not help, it records who added the row.
--
-- auth_tokens cannot answer it either. The nightly sweep deletes expired unredeemed rows, so
-- the evidence of an invite disappears exactly when it matters most — a week after sending,
-- when someone is wondering why that person never appeared.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz;

-- Anyone who already has a password was invited at some point, so backfill them rather than
-- relabelling existing people "Not invited" the moment this ships.
UPDATE users SET invited_at = created_at
 WHERE invited_at IS NULL AND password_set_at IS NOT NULL;
