/**
 * Reorder rhythm, as pure functions.
 *
 * A print shop's repeat business has a cadence — banners every spring, business cards when
 * someone runs out — and the useful question is "is this customer overdue?". That is a
 * judgement about a sequence of dates, so it is worked out here where it can be tested,
 * rather than inside a query nobody can exercise.
 */

export type Radar = 'reorder_due' | 'lapsed' | 'seasonal' | null;

/** Days between consecutive orders, oldest first. */
export function gaps(orderedAt: Date[]): number[] {
  const sorted = [...orderedAt].sort((a, b) => a.getTime() - b.getTime());
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    out.push(Math.round((sorted[i].getTime() - sorted[i - 1].getTime()) / 86_400_000));
  }
  return out;
}

/**
 * The interval to expect, learned from past orders.
 *
 * Median, not mean: one customer who ordered twice in a week and then not for a year would
 * otherwise get an "expected" interval that matches neither. Needs two gaps — a single gap
 * is one coincidence, not a rhythm.
 */
export function learnInterval(orderedAt: Date[]): number | null {
  const g = gaps(orderedAt).filter((d) => d >= 1);
  if (g.length < 2) return null;
  const s = [...g].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return median > 0 ? median : null;
}

export interface Standing {
  lastOrderAt: Date | null;
  intervalDays: number | null;
  /** How long with no order at all before a customer counts as lapsed. */
  lapsedAfterDays: number;
  now: Date;
}

/**
 * Where a customer sits.
 *
 * Deliberately conservative about `reorder_due`: it fires only for a customer with a learned
 * or stated rhythm, at 90% of it. Guessing a rhythm from a single order would put every
 * one-off job on a chase list, which is how a shop ends up pestering people who were never
 * going to come back.
 */
export function radarFor(s: Standing): Radar {
  if (!s.lastOrderAt) return null;
  const days = Math.floor((s.now.getTime() - s.lastOrderAt.getTime()) / 86_400_000);

  if (s.intervalDays && s.intervalDays > 0) {
    if (days >= Math.round(s.intervalDays * 0.9)) {
      // Long past due with a known rhythm is lapsed, not merely due.
      return days >= s.intervalDays * 2.5 ? 'lapsed' : 'reorder_due';
    }
    return null;
  }

  return days >= s.lapsedAfterDays ? 'lapsed' : null;
}
