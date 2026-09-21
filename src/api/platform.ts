import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env } from '../env';
import { withOrg, type Sql } from '../db';

/**
 * Provisioning a tenant.
 *
 * Everything that had to be done by hand from SETUP-LOG.md to put Dumont live: the org row,
 * its hostname, the ticket counter, the first admin, and a starter chat flow. Onboarding
 * customer number two should not cost a day of somebody following a runbook, and a runbook
 * is also where onboarding quietly diverges between tenants.
 *
 * Guarded by the platform operator token rather than a session, because no session can exist
 * for a tenant that does not exist yet. It sits outside /api on purpose — the whole of /api
 * resolves an org from the hostname first, which is precisely what this is creating.
 */

type Vars = { sql: Sql };
export const platform = new Hono<{ Bindings: Env; Variables: Vars }>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

platform.use('*', async (c, next) => {
  const token = c.req.header('x-admin-token');
  if (!c.env.SESSION_SECRET || !token || !timingSafeEqual(token, c.env.SESSION_SECRET)) {
    return c.json({ error: 'operator token required' }, 403);
  }
  await next();
});

const NewOrg = z.object({
  // Lower-case and hyphenated: it becomes a hostname label and an email local part, and a
  // slug that is legal in one but not the other produces an address nobody can write to.
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lower-case letters, digits and hyphens'),
  name: z.string().min(1).max(80),
  ticket_prefix: z.string().regex(/^[A-Z]{2,5}$/, 'two to five capitals').optional(),
  admin: z.object({ name: z.string().min(1), email: z.string().email() }),
  hostname: z.string().min(3).optional(),
  sms_number: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164, like +15597852474').optional(),
  brand: z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    ink: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    paper: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).optional(),
  first_ticket: z.number().int().min(1).optional(),
});

platform.get('/orgs', async (c) => {
  const sql = c.get('sql');
  // orgs and org_domains are outside RLS and read directly. users and leads are not, and
  // counting them from here returned zero for every tenant — the rows were invisible, not
  // absent. Each count runs inside its own org's context.
  const orgs = await sql<{ id: string; slug: string; name: string; status: string; created_at: string; hostnames: string | null }[]>`
    SELECT o.id, o.slug, o.name, o.status, o.created_at,
           (SELECT string_agg(d.hostname, ', ') FROM org_domains d WHERE d.org_id = o.id) AS hostnames
      FROM orgs o ORDER BY o.created_at`;

  const out = [];
  for (const o of orgs) {
    const counts = await withOrg(sql, o.id, async (tx) => {
      const [r] = await tx<{ users: number; leads: number }[]>`
        SELECT (SELECT count(*)::int FROM users WHERE org_id = ${o.id}) AS users,
               (SELECT count(*)::int FROM leads WHERE org_id = ${o.id}) AS leads`;
      return r;
    });
    out.push({ ...o, ...counts });
  }
  return c.json({ orgs: out });
});

/**
 * Create a tenant, everything it needs to answer a request, in one transaction.
 *
 * Deliberately not idempotent on slug: a second call with the same slug is far more likely
 * to be a mistake than an intention, and quietly returning the existing tenant would hide it.
 */
platform.post('/orgs', async (c) => {
  const parsed = NewOrg.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad tenant', detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const sql = c.get('sql');

  const [clash] = await sql<{ slug: string }[]>`SELECT slug FROM orgs WHERE slug = ${b.slug}`;
  if (clash) return c.json({ error: `the slug "${b.slug}" is taken` }, 409);

  const orgId = ulid();
  const userId = ulid();
  const hostname = (b.hostname ?? `${b.slug}.${c.env.PLATFORM_DOMAIN}`).toLowerCase();
  const inbound = `${b.slug}@in.midlayr.com`;

  let created;
  try {
  created = await sql.begin(async (tx) => {
    // orgs and org_domains sit outside RLS — resolution has to happen before a tenant
    // context can exist — so these two inserts are the only ones written unscoped.
    await tx`INSERT INTO orgs (id, slug, name, status, brand, comms, widget, features)
             VALUES (${orgId}, ${b.slug}, ${b.name}, 'active',
                     ${tx.json({
                       color: b.brand?.color ?? '#0B7FA8',
                       ink: b.brand?.ink ?? '#14161A',
                       paper: b.brand?.paper ?? '#FBFAF8',
                       app_name: `${b.name} · Front Desk`,
                       app_name_public: b.name,
                       bot_name: b.name.split(' ')[0],
                       ticket_prefix: b.ticket_prefix ?? b.slug.slice(0, 2).toUpperCase(),
                       show_powered_by: true,
                     } as never)},
                     ${tx.json({ email_inbound: inbound, ...(b.sms_number ? { sms_number: b.sms_number } : {}) } as never)},
                     ${tx.json({} as never)}, ${tx.json({} as never)})`;

    // hostname is the primary key here; there is no id column, and kind is NOT NULL.
    await tx`INSERT INTO org_domains (hostname, org_id, kind, verified_at)
             VALUES (${hostname}, ${orgId}, 'app', now())`;

    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    await tx`INSERT INTO counters (org_id, next_ticket) VALUES (${orgId}, ${b.first_ticket ?? 1000})`;
    // No password: an account nobody can sign into yet is the safe state to leave one in,
    // and the operator sets the first one deliberately afterwards.
    await tx`INSERT INTO users (id, org_id, email, name, role)
             VALUES (${userId}, ${orgId}, ${b.admin.email.toLowerCase()}, ${b.admin.name}, 'admin')`;

    // Something for the widget to serve on day one; every word of it is editable.
    await tx`INSERT INTO chat_flows (id, org_id, slug, name, steps, updated_by)
             VALUES (${ulid()}, ${orgId}, 'quote-intake', 'Quote intake',
                     ${tx.json([
                       { kind: 'ask', id: ulid(), prompt: 'Welcome — how can we help today?', field: 'product', chips: '' },
                       { kind: 'ask', id: ulid(), prompt: 'How many do you need?', field: 'qty', chips: '' },
                       { kind: 'ask', id: ulid(), prompt: 'Who am I speaking with?', field: 'name', chips: '' },
                       { kind: 'ask', id: ulid(), prompt: "What's the best email for the quote?", field: 'email', chips: '' },
                       { kind: 'rule', words: 'rush,urgent,asap,human,person', handoff: 'Let me bring someone in — one moment.', route: 'live' },
                       { kind: 'ticket', text: 'Thanks — that is in the queue and someone will come back to you shortly.' },
                     ] as never)}, ${userId})`;

    return { orgId, userId, hostname, inbound };
  });
  } catch (err) {
    // The caller holds the operator token and is provisioning; a bare 500 tells them
    // nothing about which of five inserts refused them.
    console.error('provision failed', err);
    const e = err as { message?: string; code?: string; detail?: string; constraint_name?: string;
                       column_name?: string; table_name?: string; routine?: string; cause?: unknown };
    return c.json({
      error: e?.message ?? String(err),
      code: e?.code, detail: e?.detail, column: e?.column_name, table: e?.table_name,
      constraint: e?.constraint_name,
      cause: e?.cause ? String((e.cause as { message?: string })?.message ?? e.cause) : undefined,
    }, 500);
  }

  return c.json({
    ok: true,
    org: { id: created.orgId, slug: b.slug, name: b.name },
    admin: { id: created.userId, email: b.admin.email },
    hostname: created.hostname,
    email_inbound: created.inbound,
    // Said plainly, because these are the parts a database cannot do for itself.
    next_steps: [
      `Set the admin's password: POST /api/users/${created.userId}/password with x-admin-token and x-dev-user`,
      `Publish the starter flow: POST /api/flows/quote-intake/publish`,
      b.sms_number
        ? `Point ${b.sms_number}'s SMS and voice webhooks at this Worker`
        : 'Buy a Twilio number, set comms.sms_number, and point its webhooks here',
      `Mail to ${created.inbound} already routes — the Mailgun catch-all covers every tenant`,
      `DNS: ${created.hostname} must resolve to this Worker before anyone can sign in`,
    ],
  }, 201);
});
