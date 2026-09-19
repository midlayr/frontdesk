import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Env, Job } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { ticketPrefix } from '../org';

/**
 * Routes the Durable Objects call back into, because a DO has no Hyperdrive binding of its
 * own and cannot reach Postgres directly.
 *
 * These live on the same public hostname as everything else, so every one of them is behind
 * a constant-time check of x-internal-token against SESSION_SECRET. Only code holding that
 * secret — the DOs, via the INTERNAL self-binding — can create leads or write turns.
 */
// Uses the router's per-request Postgres client. Calling connect() here and handing
// sql.end() straight to waitUntil closes the socket before the queries run — the same
// CONNECTION_ENDED failure the SMS webhook hit.
export const internal = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

internal.use('*', async (c, next) => {
  const token = c.req.header('x-internal-token');
  if (!token || !c.env.SESSION_SECRET || !timingSafeEqual(token, c.env.SESSION_SECRET)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
});

interface Turn { who: 'visitor' | 'bot' | 'rep'; text: string; at: number }

/** A chat turn's author, in the form the messages table expects. */
function authorOf(t: Turn, repId: string | null): string {
  if (t.who === 'visitor') return 'visitor';
  if (t.who === 'bot') return 'bot';
  return repId ?? 'rep';
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;

interface Contact { email?: string; phone?: string; name?: string; company?: string }

/**
 * Turn captured answers into a contact.
 *
 * A flow can ask for name/company/email/phone by name, and those are taken at face value.
 * The older generic `contact` field is a free-text "best email or mobile", so it still gets
 * sniffed — but only to fill a slot an explicit question did not already answer.
 */
function contactFrom(captured: Record<string, string>): Contact {
  const val = (k: string) => (typeof captured[k] === 'string' ? captured[k].trim() : '');
  const out: Contact = {};

  if (val('email')) out.email = val('email');
  if (val('phone')) out.phone = val('phone').replace(/[^\d+]/g, '');
  if (val('name')) out.name = val('name');
  if (val('company')) out.company = val('company');

  const generic = val('contact');
  if (generic) {
    if (!out.email && EMAIL.test(generic)) out.email = generic;
    else if (!out.phone && PHONE.test(generic)) out.phone = generic.replace(/[^\d+]/g, '');
    else if (!out.name && !EMAIL.test(generic) && !PHONE.test(generic)) out.name = generic;
  }
  return out;
}

async function nextTicket(tx: Tx, orgId: string, prefix: string): Promise<string> {
  const [row] = await tx<{ n: number }[]>`
    UPDATE counters SET next_ticket = next_ticket + 1
     WHERE org_id = ${orgId} RETURNING next_ticket - 1 AS n`;
  if (!row) throw new Error(`no counters row for org ${orgId}`);
  return `${prefix}-${row.n}`;
}

/** Chat reached the point of being a real enquiry: create contact + lead + chat_sessions row. */
internal.post('/leads/from-chat', async (c) => {
  const body = await c.req.json<{
    orgId: string; sessionId: string; captured: Record<string, string>;
    visitor: Record<string, string | null>; flowId: string; flowVersion: number;
  }>();

  const sql = c.get('sql');

  // orgs is outside RLS, so the prefix lookup happens before the tenant context opens.
  const [org] = await sql<{ slug: string; brand: Record<string, unknown> }[]>`
    SELECT slug, brand FROM orgs WHERE id = ${body.orgId}`;
  if (!org) return c.json({ error: 'unknown org' }, 404);
  const prefix = ticketPrefix({ slug: org.slug, brand: org.brand } as never);

  const leadId = await withOrg(sql, body.orgId, async (tx) => {
    // The DO may retry; one chat session must not open two tickets.
    const [existing] = await tx<{ lead_id: string | null }[]>`
      SELECT lead_id FROM chat_sessions WHERE id = ${body.sessionId}`;
    if (existing?.lead_id) return existing.lead_id;

    const contact = contactFrom(body.captured);

    // A named company becomes a real companies row, so the second enquiry from the same
    // shop lands against the same account rather than a duplicate.
    let companyId: string | null = null;
    if (contact.company) {
      const [found] = await tx<{ id: string }[]>`
        SELECT id FROM companies
         WHERE org_id = ${body.orgId} AND lower(name) = lower(${contact.company}) LIMIT 1`;
      companyId = found?.id ?? ulid();
      if (!found) {
        await tx`INSERT INTO companies (id, org_id, name) VALUES (${companyId}, ${body.orgId}, ${contact.company})`;
      }
    }

    let contactId: string | null = null;
    if (contact.email || contact.phone) {
      const [found] = await tx<{ id: string }[]>`
        SELECT id FROM contacts
         WHERE org_id = ${body.orgId}
           AND ((${contact.email ?? null}::text IS NOT NULL AND email = ${contact.email ?? null})
             OR (${contact.phone ?? null}::text IS NOT NULL AND phone = ${contact.phone ?? null}))
         LIMIT 1`;
      contactId = found?.id ?? ulid();
      if (found) {
        // Returning visitor: fill blanks from this conversation without clobbering
        // anything a rep may have corrected by hand.
        await tx`UPDATE contacts SET
                   name = COALESCE(name, ${contact.name ?? null}),
                   email = COALESCE(email, ${contact.email ?? null}),
                   phone = COALESCE(phone, ${contact.phone ?? null}),
                   company_id = COALESCE(company_id, ${companyId})
                 WHERE id = ${contactId}`;
      } else {
        await tx`INSERT INTO contacts (id, org_id, company_id, name, email, phone, source)
                 VALUES (${contactId}, ${body.orgId}, ${companyId}, ${contact.name ?? null},
                         ${contact.email ?? null}, ${contact.phone ?? null}, 'chat')`;
      }
    }

    const id = ulid();
    const ticketNo = await nextTicket(tx, body.orgId, prefix);
    await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, spec)
             VALUES (${id}, ${body.orgId}, ${ticketNo}, ${contactId}, ${companyId}, 'chat', 'live',
                     ${tx.json({ captured: body.captured })})`;

    await tx`INSERT INTO chat_sessions (id, org_id, flow_id, flow_version, lead_id, visitor_id, state, visitor, captured, do_id)
             VALUES (${body.sessionId}, ${body.orgId}, ${body.flowId}, ${body.flowVersion}, ${id},
                     ${String(body.visitor.vid ?? body.sessionId)}, 'bot',
                     ${tx.json(body.visitor)}, ${tx.json(body.captured)}, ${body.sessionId})
             ON CONFLICT (id) DO UPDATE SET lead_id = EXCLUDED.lead_id`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${body.orgId}, ${id}, 'system', 'lead_created',
                     ${tx.json({ channel: 'chat', ticket_no: ticketNo })})`;
    return id;
  });

  return c.json({ leadId });
});

/** Flush the DO's turn log into messages, and keep chat_sessions in step. */
internal.post('/leads/chat-turns', async (c) => {
  const body = await c.req.json<{
    orgId: string; leadId: string; sessionId: string;
    turns: Turn[]; state: string; captured: Record<string, string>;
  }>();

  const sql = c.get('sql');

  await withOrg(sql, body.orgId, async (tx) => {
    const [session] = await tx<{ rep_id: string | null }[]>`
      SELECT rep_id FROM chat_sessions WHERE id = ${body.sessionId}`;

    // The DO replays its whole turn log each flush, so a deterministic id per turn makes
    // the insert idempotent rather than duplicating the conversation on every persist.
    for (const [i, t] of body.turns.entries()) {
      await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, provider_id, sent_at)
               VALUES (${`${body.sessionId}:${i}`}, ${body.leadId}, 'chat',
                       ${t.who === 'visitor' ? 'in' : 'out'},
                       ${authorOf(t, session?.rep_id ?? null)}, ${t.text}, NULL,
                       ${new Date(t.at).toISOString()})
               ON CONFLICT (id) DO NOTHING`;
    }

    await tx`UPDATE chat_sessions
                SET state = ${body.state}::chat_state,
                    captured = ${tx.json(body.captured)},
                    ended_at = CASE WHEN ${body.state} = 'done' THEN now() ELSE ended_at END
              WHERE id = ${body.sessionId}`;

    await tx`UPDATE leads
                SET status = CASE
                      WHEN ${body.state} = 'live' THEN 'live'::lead_status
                      WHEN ${body.state} = 'done' AND status = 'live' THEN 'new'::lead_status
                      ELSE status END
              WHERE id = ${body.leadId}`;
  });

  return c.json({ ok: true });
});

export type { Job };
