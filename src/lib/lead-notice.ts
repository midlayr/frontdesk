import type { Letter } from './email-layout';

/**
 * The letter a shop gets when the bot finishes taking a job.
 *
 * Kept as a pure function of plain facts so the wording can be tested without a database,
 * a mail provider, or any chance of something actually leaving the building.
 *
 * It is addressed to a colleague, not a customer, so it is a 'notice': the shop's mark, a
 * heading you can place in a crowded inbox, and a button to the ticket. The job is to let
 * somebody decide whether to stop what they are doing — not to reproduce the conversation,
 * which is on the ticket and always will be.
 */

export interface LeadFacts {
  ticketNo: string;
  /** Whoever the job is for: company if we have one, else the person, else neither. */
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** The shop's own short name for the job, when the extractor has written one. */
  description: string | null;
  product: string | null;
  qty: number | null;
  /** Answers the bot collected that no column covers — usually everything under Notes. */
  answers: [string, string][];
  /** The rep the customer named, when they named one we recognise. */
  repName: string | null;
  /** Absolute, because an email client will not resolve a relative path. */
  ticketUrl: string;
}

const who = (f: LeadFacts): string =>
  f.company || f.contactName || f.contactEmail || f.contactPhone || 'Someone';

/** "500 × Business cards", as much of it as we actually know. */
function headline(f: LeadFacts): string | null {
  const bits = [f.qty != null ? f.qty.toLocaleString('en-US') : null, f.product].filter(Boolean);
  return bits.length ? bits.join(' × ') : f.description;
}

export function leadNotice(f: LeadFacts): Letter {
  const name = who(f);

  const body: string[] = [];

  /*
   * The first line says why this landed with YOU rather than with the desk. A rep who was
   * named by their own customer should know that before anything else — it is the
   * difference between a job to pick up and one more notification.
   */
  body.push(f.repName
    ? `${name} asked for you by name.`
    : `${name} has sent in a job through the website chat.`);

  const what = headline(f);
  if (what) body.push(what);

  // Only what a person needs to act: enough to call them back without opening anything.
  const reach = [f.contactName, f.contactEmail, f.contactPhone].filter(Boolean).join(' · ');
  if (reach) body.push(reach);

  /*
   * The bot's own questions, trimmed. Several questions can land on one field, so this is
   * where "what's the artwork like" and "any special finishing" actually surface — but an
   * email that reprints the whole conversation stops being read, so the ticket keeps the
   * full set and this carries the first few.
   */
  for (const [, value] of f.answers.slice(0, 4)) {
    for (const line of value.split('\n').slice(0, 3)) if (line.trim()) body.push(line.trim());
  }

  return {
    variant: 'notice',
    heading: `${f.ticketNo} · ${name}`,
    body,
    action: { label: 'Open the ticket', url: f.ticketUrl },
    fine: f.repName
      ? `You are the rep on this one, so it is already assigned to you.`
      : `Nobody is on this yet — it is sitting in the queue for whoever picks it up.`,
  };
}
