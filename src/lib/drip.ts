/**
 * Drip decisions, as pure functions.
 *
 * Everything that decides *whether* and *when* a step goes out lives here, away from the
 * database and the providers, because these are the rules that do real damage when they are
 * wrong: a message at 3am, a follow-up to someone who already replied, or `{first_name}`
 * arriving literally in a customer's inbox. They are testable without a tenant, a queue or
 * a send.
 */

export interface SendWindow {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[];
  start: string;   // 'HH:MM' local to tz
  end: string;     // 'HH:MM' local to tz
  tz: string;      // IANA zone
}

export const DEFAULT_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', tz: 'America/Los_Angeles',
};

/** Minutes past local midnight, or null if the value is not HH:MM. */
function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

interface Local { year: number; month: number; day: number; minute: number; weekday: number }

/** What the clock on the wall says in `tz` at this instant. */
export function localParts(at: Date, tz: string): Local {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // 24:00 is how some zones report midnight under hour12:false.
    minute: (Number(p.hour) % 24) * 60 + Number(p.minute),
    weekday: WD[p.weekday] ?? 1,
  };
}

/** The offset of `tz` at this instant, in milliseconds. */
function offsetAt(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minute / 60), p.minute % 60);
  return asUtc - at.getTime();
}

/**
 * The instant at which a wall-clock time in `tz` occurs.
 *
 * Resolved twice because the offset depends on the instant we are trying to find: guessing
 * with the offset at the naive time and correcting once lands on the right side of a
 * daylight-saving change, which a single pass does not.
 */
export function instantOf(y: number, m: number, d: number, mins: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  const first = naive - offsetAt(new Date(naive), tz);
  return new Date(naive - offsetAt(new Date(first), tz));
}

export function isOpen(at: Date, w: SendWindow): boolean {
  const start = minutes(w.start), end = minutes(w.end);
  if (start === null || end === null || !w.days.length) return false;
  const p = localParts(at, w.tz);
  if (!w.days.includes(p.weekday)) return false;
  return p.minute >= start && p.minute < end;
}

/**
 * When this step may go out.
 *
 * Returns `at` itself while the window is open, otherwise the next opening instant. A
 * window that can never open — no days, or an end at or before its start — returns null
 * rather than a date, so the caller holds the step instead of quietly sending anyway or
 * looping over a week of candidates.
 */
export function nextOpen(at: Date, w: SendWindow): Date | null {
  const start = minutes(w.start), end = minutes(w.end);
  if (start === null || end === null || end <= start) return null;
  const days = [...new Set(w.days)].filter((d) => d >= 1 && d <= 7);
  if (!days.length) return null;

  if (isOpen(at, w)) return at;

  const p = localParts(at, w.tz);
  // Today still counts when the window has not opened yet; otherwise start looking tomorrow.
  const from = days.includes(p.weekday) && p.minute < start ? 0 : 1;
  for (let i = from; i <= 7; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const wd = ((day.getUTCDay() + 6) % 7) + 1;   // JS Sunday=0 → ISO Monday=1
    if (!days.includes(wd)) continue;
    return instantOf(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), start, w.tz);
  }
  return null;
}

/** Everything the stop checks look at, gathered once per enrollment. */
export interface Standing {
  optedOut: boolean;
  leadStatus: string;
  archived: boolean;
  /** An inbound message on the lead after the enrollment began. */
  inboundSince: boolean;
  /** A rep sent something by hand after the last drip went out. */
  repRepliedSince: boolean;
}

export type Stop = 'opted_out' | 'completed' | 'replied' | 'paused';

/**
 * Whether this enrollment should still send, and why not.
 *
 * Order is deliberate. Opt-out first because it is the one with legal weight and must win
 * over every other state. A reply outranks the lead's status: someone who answers an hour
 * before a rep marks the job won should be recorded as having replied, not as completed.
 */
export function stopReason(s: Standing): Stop | null {
  if (s.optedOut) return 'opted_out';
  if (s.inboundSince) return 'replied';
  if (s.repRepliedSince) return 'paused';
  if (s.archived) return 'completed';
  if (['won', 'lost', 'closed', 'spam'].includes(s.leadStatus)) return 'completed';
  return null;
}

export const TOKENS = [
  'first_name', 'company', 'qty', 'product', 'size', 'stock', 'deadline',
  'quote_amount', 'quote_link', 'ticket_no', 'rep_name', 'rep_phone',
] as const;

export type Token = (typeof TOKENS)[number];

export interface Filled { text: string; missing: string[] }

/**
 * Substitute merge tokens, and report the ones that had nothing to put there.
 *
 * A blank is never substituted. "Hi ," reads as a mistake to a customer and as a working
 * send to us, which is the worst combination — so the caller holds the enrollment instead
 * and the rep is told which field to fill.
 */
export function fill(body: string, values: Partial<Record<string, string | number | null>>): Filled {
  const missing: string[] = [];
  const text = body.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = values[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      if (!missing.includes(key)) missing.push(key);
      return whole;
    }
    return String(v);
  });
  return { text, missing };
}

/** `missing:{qty}` — the shape enrollments.held_reason carries, and the UI reads back. */
export const heldReason = (missing: string[]) => `missing:${missing.map((m) => `{${m}}`).join(' ')}`;

/** The field names a held reason refers to, so a lead PATCH can tell if it unblocks one. */
export function heldFields(reason: string | null): string[] {
  if (!reason?.startsWith('missing:')) return [];
  return [...reason.slice(8).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}
