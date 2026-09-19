// Midlayr Front Desk · Worker entry
import { Hono, type Context } from 'hono';
import type { Env, Job, Org } from './env';
import { connect, withOrg, type Sql } from './db';
import { resolveOrg } from './org';
import { twilioSms } from './hooks/twilio-sms';
import { extractSpecs } from './jobs/extract-specs';
import { leads } from './api/leads';
import { internal } from './api/internal';
import { widget } from './api/widget';
import { flows } from './api/flows';
import { CHAT_JS } from './widget-asset';
import { mintTicket, readTicket } from './ws-ticket';
import { CONSOLE_HTML } from './web-console';
import { TEST_HTML } from './web-test';

export { ChatSession } from './do/chat-session';
export { InboxRoom } from './do/inbox-room';
export type { Env, Job };

type Vars = { org: Org; sql: Sql; userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function isDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// One Postgres client per request, closed after the response is sent.
app.use('*', async (c, next) => {
  const sql = connect(c.env);
  c.set('sql', sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
});

// Internal routes are guarded by x-internal-token inside the router, not by hostname.
app.route('/internal', internal);

// Public widget surface: anonymous visitors, tenant from ?org=<slug>.
app.route('/widget', widget);

/**
 * The drop-in script.
 *
 * Served at /w.js, not /chat.js: EasyList and friends match "chat.js" and block it outright,
 * so the widget silently never loads for anyone running an ad blocker. /widget/chat.js stays
 * as an alias for anything already pointing at it, but new installs should use /w.js.
 */
const serveWidget = (c: Context<{ Bindings: Env; Variables: Vars }>) =>
  c.body(CHAT_JS, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
app.get('/w.js', serveWidget);
app.get('/widget/chat.js', serveWidget);

// Webhooks resolve their own tenant (from the number dialled, not the hostname).
app.post('/hooks/twilio/sms', (c) => twilioSms(c.req.raw, c.env, c.get('sql')));

// Everything below is tenant-scoped by hostname.
app.use('/api/*', async (c, next) => {
  const url = new URL(c.req.url);
  const org = await resolveOrg(c.env, c.get('sql'), url);
  // Naming the hostname turns "unknown tenant" from a guess into the org_domains row you need.
  if (!org) return c.json({ error: 'unknown tenant', hostname: url.hostname }, 404);
  c.set('org', org);
  await next();
});

/**
 * Auth. Two ways in, and interactive user sessions are still neither of them.
 *
 * 1. localhost: `x-dev-user: <users.id>` alone, for `wrangler dev`.
 * 2. anywhere: `x-admin-token` matching SESSION_SECRET, plus `x-dev-user` to say who to act
 *    as. This is an operator credential for testing and automation, not a user session —
 *    whoever holds the secret can act as any user in any tenant, so it belongs in a
 *    password manager and nowhere near a browser.
 *
 * Real sessions (signed cookie, login flow) remain to build; until they exist a browser
 * cannot authenticate at all, which is deliberate.
 */
async function authenticate(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response | null> {
  const isUpgrade = c.req.header('upgrade') === 'websocket';

  // A browser WebSocket cannot send headers. Rather than put a long-lived secret in the
  // query string, an upgrade presents a ticket minted by an ordinary authenticated request.
  if (isUpgrade) {
    const ticket = c.req.query('ticket');
    if (ticket) {
      const userId = await readTicket(c.env.SESSION_SECRET, c.get('org').id, ticket);
      if (!userId) return c.json({ error: 'bad or expired ticket' }, 401);
      const [user] = await withOrg(c.get('sql'), c.get('org').id, (tx) =>
        tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`);
      if (!user) return c.json({ error: 'unknown user for tenant' }, 401);
      c.set('userId', user.id);
      return null;
    }
  }

  const devUser = c.req.header('x-dev-user')
    ?? (isUpgrade && isDevHost(new URL(c.req.url).hostname) ? c.req.query('user') : undefined);
  const adminToken = c.req.header('x-admin-token');
  const onDevHost = isDevHost(new URL(c.req.url).hostname);

  if (!onDevHost) {
    if (!adminToken) return c.json({ error: 'session auth not implemented; use x-admin-token' }, 501);
    if (!c.env.SESSION_SECRET || !timingSafeEqual(adminToken, c.env.SESSION_SECRET)) {
      return c.json({ error: 'bad admin token' }, 401);
    }
  }

  if (!devUser) return c.json({ error: 'x-dev-user required' }, 401);

  // Looked up inside the tenant's own context, so a user id from another org resolves to
  // nothing however the caller authenticated.
  const org = c.get('org');
  const [user] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${devUser}`);
  if (!user) return c.json({ error: 'unknown user for tenant' }, 401);

  c.set('userId', user.id);
  return null;
}

app.use('/api/*', async (c, next) => {
  const failed = await authenticate(c);
  if (failed) return failed;
  await next();
});

app.get('/api/org', (c) => {
  const org = c.get('org');
  const brand = org.brand as Record<string, unknown>;
  return c.json({
    id: org.id,
    slug: org.slug,
    name: org.name,
    // logo_r2_key is an internal detail; the client gets a URL it can put in an <img>.
    brand: { ...brand, logo_url: brand.logo_r2_key ? `/widget/logo?org=${encodeURIComponent(org.slug)}` : null },
    features: org.features,
  });
});

/** Mint a ticket for the sockets. Requires ordinary auth; the ticket lasts one minute. */
app.post('/api/ws-ticket', async (c) =>
  c.json({ ticket: await mintTicket(c.env.SESSION_SECRET, c.get('org').id, c.get('userId')) }));

app.route('/api/leads', leads);
app.route('/api/flows', flows);

/** Realtime queue updates: one InboxRoom per tenant, every open rep tab subscribed. */
app.get('/api/inbox/stream', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const org = c.get('org');
  const room = c.env.INBOX_ROOM.get(c.env.INBOX_ROOM.idFromName(org.id));
  return room.fetch('https://do/stream', c.req.raw);
});

const html = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// Two pages so the system is visible without a separate front-end deploy. The rep console
// authenticates like any other /api client; it is a working stand-in until the Pages app.
app.get('/console', () => html(CONSOLE_HTML));
app.get('/demo', () => html(TEST_HTML));

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    const sql = connect(env);
    try {
      for (const m of batch.messages) {
        const job = m.body;
        try {
          switch (job.kind) {
            case 'extract_specs':
              await extractSpecs(env, sql, job.orgId, job.leadId);
              break;
            default:
              // transcribe / score_intent / enrich / import_rows / drip_send land here as
              // those channels ship. Ack rather than retry-loop an unhandled kind.
              console.warn(`queue: no handler for ${job.kind}`);
          }
          m.ack();
        } catch (err) {
          console.error(`queue: ${job.kind} failed`, err);
          m.retry(); // three attempts, then frontdesk-dlq
        }
      }
    } finally {
      await sql.end();
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // enrollments WHERE state='active' AND next_send_at <= now → JOBS.drip_send
    // leads WHERE status IN ('new','needs_info') AND created_at < now-2h → SLA nudge to InboxRoom
  },
} satisfies ExportedHandler<Env, Job>;
