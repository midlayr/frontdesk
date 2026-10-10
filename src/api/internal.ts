import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Env, Job, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { ticketPrefix } from '../org';
import { onLeadCreated } from '../lib/enroll';
import { matchRep } from '../lib/rep-match';
import { leadNotice } from '../lib/lead-notice';
import { render } from '../lib/email-layout';
import { mailFrom } from '../lib/mail-from';
import { sendEmail } from '../lib/mailgun';

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
/**
 * Open a ticket for an email.
 *
 * Separate from the chat path because the identity is different: an email always carries a
 * usable address, so the contact is matched on it and reused across enquiries — which is
 * what makes a returning customer one record rather than a new one every quarter.
 */
internal.post('/leads/from-email', async (c) => {
  const body = await c.req.json<{
    orgId: string;
    contact: { name: string | null; email: string };
    subject: string; body: string;
    assigneeId: string | null; status: string;
  }>();

  const sql = c.get('sql');
  const [org] = await sql<{ slug: string; brand: Record<string, unknown> }[]>`
    SELECT slug, brand FROM orgs WHERE id = ${body.orgId}`;
  if (!org) return c.json({ error: 'unknown org' }, 404);
  const prefix = ticketPrefix({ slug: org.slug, brand: org.brand } as never);

  const out = await withOrg(sql, body.orgId, async (tx) => {
    const email = body.contact.email.toLowerCase();

    let [contact] = await tx<{ id: string; name: string | null }[]>`
      SELECT id, name FROM contacts WHERE org_id = ${body.orgId} AND email = ${email} LIMIT 1`;
    if (!contact) {
      const id = ulid();
      await tx`INSERT INTO contacts (id, org_id, name, email, source)
               VALUES (${id}, ${body.orgId}, ${body.contact.name}, ${email}, 'inbound')`;
      contact = { id, name: body.contact.name };
    } else if (!contact.name && body.contact.name) {
      await tx`UPDATE contacts SET name = ${body.contact.name} WHERE id = ${contact.id}`;
    }

    const ticketNo = await nextTicket(tx, body.orgId, prefix);
    const leadId = ulid();
    await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, channel, status, assignee_id, spec)
             VALUES (${leadId}, ${body.orgId}, ${ticketNo}, ${contact.id}, 'email',
                     ${body.status}::lead_status, ${body.assigneeId},
                     ${tx.json({ subject: body.subject })})`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${body.orgId}, ${leadId}, 'system', 'lead_created',
                     ${tx.json({ channel: 'email', ticket_no: ticketNo, from: email })})`;

    await onLeadCreated(tx, body.orgId, leadId);

    return { id: leadId, ticket_no: ticketNo };
  });

  return c.json(out);
});

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

    /*
     * "Who is your account rep?" — if the bot asked and the answer names somebody real, the
     * ticket opens already assigned to them instead of landing in the general pile.
     *
     * Disabled people are left out of the candidates: somebody who has left the shop should
     * not keep being handed work because their name is still a chip in the flow.
     *
     * A name that matches nobody is not an error. The ticket stays unassigned, which is
     * exactly where it would have been had the question never been asked — but the attempt
     * is recorded below, because a chip that has drifted from the Team page is invisible
     * otherwise, and the symptom is simply that routing quietly stops working.
     */
    const people = await tx<{ id: string; name: string; email: string }[]>`
      SELECT id, name, email FROM users
       WHERE org_id = ${body.orgId} AND disabled_at IS NULL`;
    const rep = matchRep(body.captured.rep, people);

    await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status, assignee_id, spec)
             VALUES (${id}, ${body.orgId}, ${ticketNo}, ${contactId}, ${companyId}, 'chat', 'live',
                     ${rep.ok ? rep.id : null},
                     ${tx.json({ captured: body.captured })})`;

    if (rep.ok) {
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${body.orgId}, ${id}, 'system', 'assigned',
                       ${tx.json({ to: rep.id, name: rep.name, why: 'named in chat' })})`;
    } else if (rep.why !== 'blank') {
      // Says what the customer picked and why it did not land, so "the rep never got it"
      // has an answer on the ticket rather than needing someone to read the flow.
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${body.orgId}, ${id}, 'system', 'assign_failed',
                       ${tx.json({ said: rep.said, why: rep.why })})`;
    }

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

    // Same rule as replying: automation owns the inbound states, a rep owns the rest. A
    // ticket already marked Quoted or Won stays there even if the visitor opens a new chat.
    const [was] = await tx<{ status: string }[]>`SELECT status FROM leads WHERE id = ${body.leadId}`;

    await tx`UPDATE leads
                SET status = CASE
                      WHEN ${body.state} = 'live' AND status IN ('new','needs_info','replied')
                        THEN 'live'::lead_status
                      WHEN ${body.state} = 'done' AND status = 'live' THEN 'new'::lead_status
                      ELSE status END
              WHERE id = ${body.leadId}`;

    // Logged like any other stage change, so the ticket's history accounts for the whole of
    // its life rather than only the parts a human drove.
    const [now] = await tx<{ status: string }[]>`SELECT status FROM leads WHERE id = ${body.leadId}`;
    if (was && now && was.status !== now.status) {
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${body.orgId}, ${body.leadId}, 'system', 'stage',
                       ${tx.json({ from: was.status, to: now.status, auto: true })})`;
    }
  });

  return c.json({ ok: true });
});

export type { Job };

/**
 * Tell the shop a job has come in.
 *
 * Called by the chat DO the moment a conversation reaches its ticket step — not when the
 * lead row is first written, which can happen much earlier if the visitor asks for a human
 * halfway through. A rep mailed about a half-finished enquiry learns to ignore the mail.
 *
 * Where it goes is LEAD_NOTIFY_TO, and the default is silence (see env.ts). While a shop is
 * trying this out, every notice is redirected to one address and says plainly who it would
 * have gone to — so the routing can be watched working without seven people being emailed
 * about test conversations.
 */
internal.post('/leads/notify', async (c) => {
  const body = await c.req.json<{ orgId: string; leadId: string }>();
  const dest = (c.env.LEAD_NOTIFY_TO ?? '').trim();
  if (!dest) return c.json({ ok: true, sent: false, why: 'notifications are off' });

  const sql = c.get('sql');
  const [org] = await sql<Org[]>`
    SELECT id, slug, name, brand, comms, widget, features FROM orgs WHERE id = ${body.orgId}`;
  if (!org) return c.json({ error: 'unknown org' }, 404);

  const facts = await withOrg(sql, body.orgId, async (tx) => {
    // Written before the send and checked here, so a retried DO call cannot mail twice.
    const [already] = await tx<{ id: string }[]>`
      SELECT id FROM activity
       WHERE lead_id = ${body.leadId} AND kind = 'lead_notified' LIMIT 1`;
    if (already) return null;

    const [l] = await tx<{
      ticket_no: string; description: string | null; product: string | null; qty: number | null;
      spec: { captured?: Record<string, string> } | null;
      contact_name: string | null; contact_email: string | null; contact_phone: string | null;
      company_name: string | null; rep_name: string | null; rep_email: string | null;
    }[]>`
      SELECT l.ticket_no, l.description, l.product, l.qty, l.spec,
             ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone,
             co.name AS company_name, u.name AS rep_name, u.email AS rep_email
        FROM leads l
        LEFT JOIN contacts ct ON ct.id = l.contact_id
        LEFT JOIN companies co ON co.id = l.company_id
        LEFT JOIN users u ON u.id = l.assignee_id
       WHERE l.id = ${body.leadId}`;
    if (!l) return null;

    // Admins are the fallback: somebody has to see a job nobody was named on, and they are
    // the people who can hand it out.
    const admins = await tx<{ email: string }[]>`
      SELECT email FROM users
       WHERE org_id = ${body.orgId} AND role = 'admin' AND disabled_at IS NULL`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${body.orgId}, ${body.leadId}, 'system', 'lead_notified',
                     ${tx.json({ to: dest === 'rep' ? (l.rep_email ?? 'admins') : dest })})`;
    return { l, admins: admins.map((a) => a.email) };
  });

  if (!facts) return c.json({ ok: true, sent: false, why: 'already notified, or no such lead' });
  const { l, admins } = facts;

  // Only the answers with no column of their own — the rest is already in the letter.
  const HOME = new Set(['product', 'qty', 'size', 'stock', 'color', 'finish', 'deadline',
                        'name', 'company', 'email', 'phone', 'contact', 'rep']);
  const answers = Object.entries(l.spec?.captured ?? {})
    .filter(([k, v]) => !HOME.has(k) && typeof v === 'string' && v.trim()) as [string, string][];

  const origin = c.env.PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '';
  const letter = leadNotice({
    ticketNo: l.ticket_no, company: l.company_name, contactName: l.contact_name,
    contactEmail: l.contact_email, contactPhone: l.contact_phone,
    description: l.description, product: l.product, qty: l.qty, answers,
    repName: l.rep_name,
    ticketUrl: `${origin}/?lead=${encodeURIComponent(body.leadId)}`,
  });

  const live = dest === 'rep';
  const to = live ? (l.rep_email ?? admins.join(',')) : dest;
  if (!to) return c.json({ ok: true, sent: false, why: 'nobody to send to' });

  if (!live) {
    // Says what would have happened, so a redirected notice is still worth reading.
    letter.fine = `Test copy — redirected here. Live, this would have gone to `
      + `${l.rep_email ?? `the shop's admins (${admins.join(', ') || 'none set'})`}.`;
  }

  const mail = render(letter, org, c.env);
  const { from, replyTo } = mailFrom(org, c.env);
  try {
    await sendEmail(c.env, {
      from, to, replyTo, inReplyTo: null, references: [],
      subject: `${l.ticket_no} · ${l.company_name ?? l.contact_name ?? 'New job'} — from the website chat`,
      text: mail.text, html: mail.html,
    });
  } catch (err) {
    // The activity row is already written, so this will not retry on its own. Loud in the
    // log rather than failing the DO's turn: the ticket exists and the visitor is fine.
    console.error('lead notify failed', err);
    return c.json({ ok: true, sent: false, why: String(err) });
  }
  return c.json({ ok: true, sent: true, to });
});
