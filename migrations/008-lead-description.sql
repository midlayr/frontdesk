-- What the job IS, in the words a person would use.
--
-- A ticket's headline has been `product · qty` — true, and reads like a database row. Pace's
-- job jacket leads with a Description ("Wedding Menu & Placards") because that is how the
-- shop refers to a job out loud, and Summer asked for the same here.
--
-- Deliberately not derived from product and qty: it is sometimes broader than either
-- ("Wedding stationery"), sometimes narrower, and sometimes, in her words, "as generic as
-- Business Cards". A rep writes it; the extractor only suggests.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS description text;

-- The queue sorts and searches on it, and it joins the existing search vector so looking up
-- "wedding" finds the job whether that word was in the description or the spec notes.
DROP INDEX IF EXISTS leads_search;
ALTER TABLE leads DROP COLUMN IF EXISTS search;
ALTER TABLE leads ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple',
    coalesce(description,'') || ' ' || coalesce(product,'') || ' ' ||
    coalesce(stock,'')       || ' ' || coalesce(spec->>'notes',''))) STORED;
CREATE INDEX leads_search ON leads USING gin (search);
