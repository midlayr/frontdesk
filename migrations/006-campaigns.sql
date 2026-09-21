-- Campaigns · from scaffold v5's schema-campaigns.sql, with three corrections that stopped
-- the original running at all. Run after 005-pathfinder.sql.

-- 1. enrollments.state is an ENUM here, not a text column with a CHECK. The scaffold drops a
--    constraint that does not exist and then adds one naming values the type cannot hold, so
--    'held' and 'removed' could never be stored. Extending the type is the equivalent.
--    These run before anything uses them: a value added to an enum is not usable until the
--    adding transaction commits.
ALTER TYPE enroll_state ADD VALUE IF NOT EXISTS 'held';
ALTER TYPE enroll_state ADD VALUE IF NOT EXISTS 'removed';

-- A drip needs somewhere to hang a conversation that began with no inbound message.
ALTER TYPE channel ADD VALUE IF NOT EXISTS 'campaign';
