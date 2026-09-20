// Midlayr Front Desk · Worker entry
import { Hono, type Context } from 'hono';
import type { Env, Job, Org } from './env';
import { connect, withOrg, type Sql } from './db';
import { resolveOrg } from './org';
import { twilioSms } from './hooks/twilio-sms';
import { twilioVoice, twilioRecording } from './hooks/twilio-voice';
import { transcribe } from './jobs/transcribe';
import { extractSpecs } from './jobs/extract-specs';
import { leads } from './api/leads';
import { internal } from './api/internal';
import { widget } from './api/widget';
import { flows } from './api/flows';
import { settings } from './api/settings';
import { CHAT_JS } from './widget-asset';
import { MEDIA_TTL_MS, mintTicket, readTicket } from './ws-ticket';
import {
  COOKIE, clearCookie, createSession, destroySession, hashPassword,
  readCookie, readSession, sessionCookie, verifyPassword,
} from './auth';
import { CONSOLE_HTML } from './web-console';

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
app.post('/hooks/twilio/voice', (c) => twilioVoice(c.req.raw, c.env, c.get('sql')));
app.post('/hooks/twilio/recording', (c) => twilioRecording(c.req.raw, c.env, c.get('sql'), c.executionCtx));

/**
 * Sign in.
 *
 * Rate-limited only by Postgres and PBKDF2's own cost for now — 210k iterations makes
 * guessing expensive, but a real deployment wants attempt throttling on top.
 */
app.post('/api/session', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password;
  if (!email || !password) return c.json({ error: 'email and password required' }, 400);

  const sql = c.get('sql');
  const org = await resolveOrg(c.env, sql, new URL(c.req.url));
  if (!org) return c.json({ error: 'unknown tenant' }, 404);

  // users is under RLS, so this has to run inside the tenant's context — a plain query
  // returns zero rows and every login looks like a wrong password. Scoping to the resolved
  // org also means a valid password cannot sign you into a tenant you do not belong to.
  const [user] = await withOrg(sql, org.id, (tx) =>
    tx<{ id: string; password_hash: string | null }[]>`
      SELECT id, password_hash FROM users WHERE email = ${email} AND org_id = ${org.id}`);

  // Same work and the same answer whether or not the account exists, so this cannot be used
  // to enumerate who has a login.
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok) return c.json({ error: 'wrong email or password' }, 401);

  const url = new URL(c.req.url);
  const { token, expires } = await createSession(
    sql, user.id, org.id, c.req.header('user-agent') ?? null, c.req.header('cf-connecting-ip') ?? null);

  c.header('set-cookie', sessionCookie(token, expires, url.protocol === 'https:'));
  return c.json({ ok: true, userId: user.id });
});

app.delete('/api/session', async (c) => {
  await destroySession(c.get('sql'), readCookie(c.req.header('cookie') ?? null, COOKIE));
  c.header('set-cookie', clearCookie(new URL(c.req.url).protocol === 'https:'));
  return c.json({ ok: true });
});

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
  const org = c.get('org');

  // A real session cookie first. It is sent automatically on fetches, WebSocket handshakes
  // and <audio>/<img> loads, which is why it replaces the ticket dance for anything
  // same-origin, and it is HttpOnly so page script cannot read or leak it.
  const cookie = readCookie(c.req.header('cookie') ?? null, COOKIE);
  if (cookie) {
    const session = await readSession(c.get('sql'), cookie);
    // The session names its own tenant; a cookie from one org must not work on another's
    // hostname even though both resolve through the same Worker.
    if (session && session.orgId === org.id) {
      c.set('userId', session.userId);
      return null;
    }
    if (session) return c.json({ error: 'session is for another tenant' }, 403);
  }

  const isUpgrade = c.req.header('upgrade') === 'websocket';

  // Neither a WebSocket nor an <audio>/<img> element can send headers, so both present a
  // ticket minted by an ordinary authenticated request: short-lived, HMAC-signed, and scoped
  // to one tenant and user. That is a capability, not a secret in a URL.
  {
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
    if (!adminToken) return c.json({ error: 'not signed in' }, 401);
    if (!c.env.SESSION_SECRET || !timingSafeEqual(adminToken, c.env.SESSION_SECRET)) {
      return c.json({ error: 'bad admin token' }, 401);
    }
  }

  if (!devUser) return c.json({ error: 'not signed in' }, 401);

  // Looked up inside the tenant's own context, so a user id from another org resolves to
  // nothing however the caller authenticated.
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

app.get('/api/me', async (c) => {
  const org = c.get('org');
  const [user] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string; name: string; email: string; role: string }[]>`
      SELECT id, name, email, role FROM users WHERE id = ${c.get('userId')}`);
  return c.json({ user, org: { id: org.id, slug: org.slug, name: org.name } });
});

/**
 * Set a user's password. Bootstrap path, so it takes the operator token rather than a
 * session — that is the legitimate use for a root credential: creating the first login.
 * A self-service change belongs behind a session and the current password.
 */
app.post('/api/users/:id/password', async (c) => {
  if (c.req.header('x-admin-token') !== c.env.SESSION_SECRET) {
    return c.json({ error: 'operator token required' }, 403);
  }
  const body = await c.req.json().catch(() => null) as { password?: string } | null;
  if (!body?.password || body.password.length < 12) {
    return c.json({ error: 'password must be at least 12 characters' }, 400);
  }

  const org = c.get('org');
  const id = c.req.param('id');
  const hash = await hashPassword(body.password);
  const [updated] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string }[]>`
      UPDATE users SET password_hash = ${hash}, password_set_at = now()
       WHERE id = ${id} RETURNING id`);
  if (!updated) return c.json({ error: 'not found' }, 404);

  // Any existing sessions belong to the old password.
  await c.get('sql')`DELETE FROM sessions WHERE user_id = ${id}`;
  return c.json({ ok: true });
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
app.post('/api/ws-ticket', async (c) => {
  const media = c.req.query('for') === 'media';
  return c.json({
    ticket: await mintTicket(c.env.SESSION_SECRET, c.get('org').id, c.get('userId'), media ? MEDIA_TTL_MS : undefined),
    expires_in: media ? MEDIA_TTL_MS : 60_000,
  });
});

app.route('/api/leads', leads);
app.route('/api/flows', flows);
app.route('/api/settings', settings);

/** Realtime queue updates: one InboxRoom per tenant, every open rep tab subscribed. */
app.get('/api/inbox/stream', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const org = c.get('org');
  const room = c.env.INBOX_ROOM.get(c.env.INBOX_ROOM.idFromName(org.id));
  return room.fetch('https://do/stream', c.req.raw);
});

const html = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// The dependency-free console predates the React app and stays as a way to poke at the API
// with nothing built. The widget test page ships as a static asset, so /demo is just its
// older name.
app.get('/console', () => html(CONSOLE_HTML));
app.get('/demo', (c) => c.redirect('/dumontprinting-test.html', 301));

app.get('/health', (c) => c.json({ ok: true }));

/**
 * SPA fallback.
 *
 * Static assets are served before the Worker runs, so anything reaching here is either a
 * real miss or a client-side route (/settings, /chat/flows/<slug>). Reloading one of those
 * must return the app, not a 404 — but only for a browser asking for a page. A miss under
 * /api, /hooks, /internal or /widget, or any non-GET, keeps its honest 404, since answering
 * a fetch() with HTML turns a typo into an unreadable JSON parse error.
 */
const APP_SHELL_EXEMPT = ['/api', '/hooks', '/internal', '/widget'];

app.notFound(async (c) => {
  const url = new URL(c.req.url);
  const wantsPage = (c.req.method === 'GET' || c.req.method === 'HEAD')
    && (c.req.header('accept') ?? '').includes('text/html')
    && !APP_SHELL_EXEMPT.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'));

  if (!wantsPage) return c.json({ error: 'not found' }, 404);

  // 200, not 404: the Worker cannot tell /chat/flows/quote-intake from a typo, and the app
  // decides which it is once it boots. index.html carries no-cache, so a later deploy is
  // picked up rather than a stale shell pointing at hashed bundles that no longer exist.
  const shell = await c.env.ASSETS.fetch(new URL('/index.html', url));
  return new Response(shell.body, { status: 200, headers: shell.headers });
});

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
            case 'transcribe':
              await transcribe(env, sql, job.orgId, job.messageId);
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
