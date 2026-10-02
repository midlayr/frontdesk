import { ulid } from 'ulid';
import type { Env, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { ticketPrefix } from '../org';
import { findThreadableLead } from '../lib/threading';
import { onLeadCreated } from '../lib/enroll';
import { stopOnReply } from './delivery';

/**
 * POST /hooks/form — a quote request from the shop's own website.
 *
 * The fifth channel, and the odd one out: the customer has already answered the intake
 * questions, so there is no prose to mine. The submission arrives as labelled pairs and is
 * kept in the order the form asked them, because that order is the shop's own — a rep
 * reading the ticket should see what the customer saw.
 *
 * `design/prototypes/leads-inbox.html` is the reference. Its WF leads carry
 * `form: [[label, value], …]` plus a file list, and the ticket renders the pairs as given
 * rather than flattening them into a sentence.
 *
 * Unauthenticated by necessity — it is posted to from a browser on someone else's page — so
 * the defences are: an Origin allowlist per tenant (the same `widget.allowed_domains` the
 * chat widget uses), a honeypot, a size cap, and nothing at all that echoes back what the
 * server knows. A bad origin is refused before any write.
 */

/** A field the form asks that maps onto a column. Everything else stays in the pairs. */
const KNOWN: Record<string, 'product' | 'qty' | 'deadline' | 'name' | 'email' | 'phone' | 'company'> = {
  'what do you need printed?': 'product',
  'what are we printing?': 'product',
  'how many do you need?': 'qty',
  'quantity': 'qty',
  'how many?': 'qty',
  'when do you need it?': 'deadline',
  'when do you need them by?': 'deadline',
  'deadline': 'deadline',
  'your name': 'name',
  'name': 'name',
  'contact': 'name',
  'email': 'email',
  'your email': 'email',
  'phone': 'phone',
  'your phone': 'phone',
  'company': 'company',
  'company name': 'company',
};

const MAX_FIELDS = 40;
const MAX_VALUE = 4000;

export type Pair = [string, string];

/**
 * Normalise whatever the form posted into ordered pairs.
 *
 * Accepts either `{fields: [[label, value], …]}` — the shape the prototype uses — or a flat
 * object, which is what an ordinary HTML form or a no-code builder will send. A flat object
 * loses nothing: JSON preserves key order for string keys, and that order is the form's.
 */
export function toPairs(body: unknown): Pair[] {
  const out: Pair[] = [];
  const push = (label: unknown, value: unknown) => {
    const l = String(label ?? '').trim();
    const v = String(value ?? '').trim();
    // An unanswered optional question is not evidence of anything; it would only take up a
    // row on the ticket and make the rep read past it.
    if (!l || !v) return;
    out.push([l.slice(0, 200), v.slice(0, MAX_VALUE)]);
  };

  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.fields)) {
      for (const f of b.fields as unknown[]) {
        if (Array.isArray(f)) push(f[0], f[1]);
        else if (f && typeof f === 'object') push((f as Pair2).label, (f as Pair2).value);
      }
    } else {
      for (const [k, v] of Object.entries(b)) {
        if (k === 'org' || k === 'files' || k === '_hp') continue;
        push(k, v);
      }
    }
  }
  return out.slice(0, MAX_FIELDS);
}
type Pair2 = { label?: unknown; value?: unknown };

/** Pull the columns we have somewhere to put. Everything stays in the pairs regardless. */
export function mapKnown(pairs: Pair[]): {
  product?: string; qty?: number; deadline?: string;
  name?: string; email?: string; phone?: string; company?: string;
} {
  const out: Record<string, string | number> = {};
  for (const [label, value] of pairs) {
    const key = KNOWN[label.trim().toLowerCase()];
    if (!key || out[key] !== undefined) continue;
    if (key === 'qty') {
      // "1,000 fall program mailers" → 1000. A quantity written in a sentence is still a
      // quantity; a wrong guess is worse than none, so only a leading number counts.
      const m = value.replace(/,/g, '').match(/^\s*(\d{1,9})\b/);
      if (m) out.qty = Number(m[1]);
    } else {
      out[key] = value;
    }
  }
  return out as ReturnType<typeof mapKnown>;
}

/** What the rep reads in the thread: the questions and the answers, in the form's order. */
export function renderBody(pairs: Pair[]): string {
  return pairs.map(([l, v]) => `${l}\n${v}`).join('\n\n');
}

function allowedOrigin(org: Org, origin: string | null): boolean {
  const domains = (org.widget as { allowed_domains?: unknown }).allowed_domains;
  if (!Array.isArray(domains) || domains.length === 0) return false;
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).hostname; } catch { return false; }
  return domains.some((d) => typeof d === 'string'
    && (d === '*' || host === d || host.endsWith(`.${d}`)));
}

async function nextTicket(tx: Tx, org: Org): Promise<string> {
  const [row] = await tx<{ n: number }[]>`
    UPDATE counters SET next_ticket = next_ticket + 1
     WHERE org_id = ${org.id} RETURNING next_ticket - 1 AS n`;
  if (!row) throw new Error(`no counters row for org ${org.id}`);
  return `${ticketPrefix(org)}-${row.n}`;
}

/**
 * Email first, then phone. A form gives us both more often than the other channels do, and
 * matching on email keeps a company's history together when somebody submits from a
 * different desk phone.
 */
async function findOrCreateContact(
  tx: Tx, orgId: string, name?: string, email?: string, phone?: string,
): Promise<string> {
  if (email) {
    const [found] = await tx<{ id: string }[]>`
      SELECT id FROM contacts WHERE org_id = ${orgId} AND email = ${email} LIMIT 1`;
    if (found) return found.id;
  }
  if (phone) {
    const [found] = await tx<{ id: string }[]>`
      SELECT id FROM contacts WHERE org_id = ${orgId} AND phone = ${phone} LIMIT 1`;
    if (found) return found.id;
  }
  const id = ulid();
  await tx`INSERT INTO contacts (id, org_id, name, email, phone, source)
           VALUES (${id}, ${orgId}, ${name ?? null}, ${email ?? null}, ${phone ?? null}, 'inbound')`;
  return id;
}

export async function formSubmit(
  req: Request, env: Env, sql: Sql, orgFor: (slug: string) => Promise<Org | null>,
): Promise<Response> {
  const origin = req.headers.get('origin');
  const cors = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        ...(origin ? { 'access-control-allow-origin': origin, 'vary': 'origin' } : {}),
      },
    });

  const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw) return cors(400, { error: 'expected a JSON body' });

  const slug = typeof raw.org === 'string' ? raw.org : '';
  if (!slug) return cors(400, { error: 'org required' });

  const org = await orgFor(slug);
  if (!org) return cors(404, { error: 'unknown tenant' });

  // Before any write, and before the honeypot: a post from a page we do not serve is not
  // this tenant's form, whatever it contains.
  if (!allowedOrigin(org, origin)) return cors(403, { error: 'origin not allowed' });

  // A field no human sees and no human fills. Answered = a bot, so accept and discard —
  // telling it it failed only teaches it what to change.
  if (typeof raw._hp === 'string' && raw._hp.trim() !== '') return cors(200, { ok: true });

  const pairs = toPairs(raw);
  if (pairs.length === 0) return cors(400, { error: 'no fields submitted' });

  const known = mapKnown(pairs);
  const body = renderBody(pairs);

  let ticketNo: string | null = null;
  let isNew = false;

  const leadId = await withOrg(sql, org.id, async (tx) => {
    const contactId = await findOrCreateContact(tx, org.id, known.name, known.email, known.phone);

    // Someone who submits the form twice in a few minutes has corrected themselves, not
    // started a second job — the same rule the other channels thread by.
    const openId = await findThreadableLead(tx, org.id, contactId);

    let id: string;
    if (openId) {
      id = openId;
    } else {
      id = ulid();
      isNew = true;
      ticketNo = await nextTicket(tx, org);
      await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, channel, status,
                                  product, qty, spec)
               VALUES (${id}, ${org.id}, ${ticketNo}, ${contactId}, 'form', 'new',
                       ${known.product ?? null}, ${known.qty ?? null},
                       ${tx.json({ form: pairs, deadline_text: known.deadline ?? null })})`;
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'lead_created',
                       ${tx.json({ channel: 'form', ticket_no: ticketNo, fields: pairs.length })})`;
    }

    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, raw)
             VALUES (${ulid()}, ${id}, 'form', 'in', 'visitor', ${body}, ${tx.json({ pairs })})`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'message_in',
                     ${tx.json({ channel: 'form' })})`;

    await stopOnReply(tx, org.id, id);
    if (isNew) await onLeadCreated(tx, org.id, id);
    return id;
  });

  // Still worth running: the free-text answers carry stock, size and finishing that no form
  // field asks for, and the extractor will not overwrite a column the form already filled.
  if (leadId) await env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId });

  // The ticket number goes back so the page can show it. Nothing else — a public endpoint
  // should not confirm which addresses or companies this shop already knows.
  return cors(200, { ok: true, ticket: ticketNo });
}

/** Preflight. The browser asks before it posts cross-origin. */
export async function formOptions(req: Request, env: Env, orgFor: (slug: string) => Promise<Org | null>): Promise<Response> {
  const origin = req.headers.get('origin');
  const slug = new URL(req.url).searchParams.get('org') ?? '';
  const org = slug ? await orgFor(slug) : null;
  if (!org || !allowedOrigin(org, origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin!,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      'vary': 'origin',
    },
  });
}
