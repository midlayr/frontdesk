-- One running enrollment per lead per sequence.
--
-- Partial rather than absolute: two drips firing at the same person from the same sequence
-- is the bug worth preventing, but re-enrolling a lead whose sequence finished months ago is
-- a legitimate thing for a rep to do, and for reorder campaigns it is the entire point.
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_running
  ON enrollments (sequence_id, lead_id)
  WHERE state IN ('active', 'held', 'paused');
