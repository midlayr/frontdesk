/**
 * Turning "Susan Moore" — typed by a visitor into a chat bubble — into a person.
 *
 * The bot asks who the customer's account rep is and gets back a chip label, which is plain
 * text: the flow's wording and the Team page's records are two separate things that nobody
 * keeps in step. So the match has to survive the ordinary drift — a double space, a stray
 * comma from the chips list, different capitalisation, "Gayle Takakjian-Gilbert" against
 * "Gayle Takakjian Gilbert".
 *
 * What it deliberately will NOT do is guess. No fuzzy distance, no first-name-only match:
 * two reps called Susan, or a half-remembered surname, must not quietly route a customer's
 * job to the wrong person. An unrecognised name is not an error — it means the ticket goes
 * to the desk to be distributed by hand, which is the same place it would have gone if the
 * customer had never been asked.
 */

export interface Candidate { id: string; name: string; email: string }

/** Case, spacing, punctuation and accents all flattened, so only the letters matter. */
function key(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type RepMatch =
  | { ok: true; id: string; name: string; email: string }
  | { ok: false; why: 'blank' | 'unknown' | 'ambiguous'; said: string };

/**
 * One rep, or nothing. `ambiguous` is kept separate from `unknown` so the ticket can say
 * which happened: two people with the same name is a thing for an admin to fix, a name
 * nobody recognises is usually a chip that drifted from the Team page.
 */
export function matchRep(said: string | undefined, people: Candidate[]): RepMatch {
  const want = key(said ?? '');
  if (!want) return { ok: false, why: 'blank', said: said ?? '' };

  const hits = people.filter((p) => key(p.name) === want);
  if (hits.length === 1) return { ok: true, id: hits[0].id, name: hits[0].name, email: hits[0].email };
  if (hits.length > 1) return { ok: false, why: 'ambiguous', said: said ?? '' };
  return { ok: false, why: 'unknown', said: said ?? '' };
}
