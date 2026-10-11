import { isOpen, type SendWindow } from './drip';

/**
 * When the shop is open.
 *
 * The same shape, and the same isOpen(), that decides whether a campaign drip may send —
 * written months ago so marketing does not arrive at 3am. A shop has one set of opening
 * hours, so a second notion of "are we open" that could disagree with the first would be a
 * bug waiting to happen.
 *
 * Org-level rather than per-bot: the quotes bot and the reorders bot are the same front
 * counter, and nobody wants to keep two copies of Monday to Friday in step.
 */
export type Hours = SendWindow;

/** Mon–Fri, 8:30 to 5, Pacific — Dumont's hours, and a sane default for a US print shop. */
export const DEFAULT_HOURS: Hours = {
  days: [1, 2, 3, 4, 5], start: '08:30', end: '17:00', tz: 'America/Los_Angeles',
};

/** Where the chat DO reads them. It has no database, so this is how hours reach it. */
export const hoursKey = (orgId: string) => `hours:${orgId}`;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Hours as stored, or the defaults.
 *
 * Anything malformed falls back whole rather than field by field: half a set of hours —
 * a valid start with a lost end — would close the shop at a time nobody chose, and the
 * failure would show up as customers being told the wrong thing rather than as an error.
 */
export function hoursOf(raw: unknown): Hours {
  const h = raw as Partial<Hours> | null | undefined;
  if (!h || typeof h !== 'object') return DEFAULT_HOURS;
  const days = Array.isArray(h.days)
    ? h.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)
    : null;
  if (!days || typeof h.start !== 'string' || typeof h.end !== 'string'
      || !HHMM.test(h.start) || !HHMM.test(h.end) || typeof h.tz !== 'string' || !h.tz) {
    return DEFAULT_HOURS;
  }
  return { days, start: h.start, end: h.end, tz: h.tz };
}

/** Open right now? A shop with no open days is closed, which isOpen already says. */
export const openAt = (h: Hours, at: Date = new Date()) => isOpen(at, h);

const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "8:30 AM" from "08:30", for telling a customer when somebody will be back. */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * "8:30 AM – 5:00 PM Monday through Friday" — the shop's hours as a person says them.
 *
 * Contiguous weekdays collapse to "Monday through Friday"; anything scattered is listed.
 * Offered as a token so the closing message does not hard-code hours that later change in
 * Settings and leave the bot telling customers the old ones.
 */
export function describe(h: Hours): string {
  const days = [...new Set(h.days)].sort((a, b) => a - b);
  if (!days.length) return 'by appointment';
  const run = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const when = days.length === 1 ? DAY[days[0]]
    : run ? `${DAY[days[0]]} through ${DAY[days[days.length - 1]]}`
    : days.map((d) => DAY[d].slice(0, 3)).join(', ');
  return `${clock(h.start)} – ${clock(h.end)} ${when}`;
}
