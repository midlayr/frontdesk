// Midlayr Front Desk · Worker entry
import { Hono, type Context } from 'hono';
import { ulid } from 'ulid';
import type { Env, Job, Org } from './env';
import { connect, withOrg, type Sql } from './db';
import { resolveOrg } from './org';
import { twilioSms } from './hooks/twilio-sms';
import { twilioVoice, twilioRecording } from './hooks/twilio-voice';
import { handleEmail } from './hooks/email';
import { mailgunInbound } from './hooks/mailgun';
import { formSubmit, formOptions } from './hooks/form';
import { mailgunEvents, twilioStatus } from './hooks/delivery';
import { transcribe } from './jobs/transcribe';
import { extractSpecs } from './jobs/extract-specs';
import { runDrips, sweepQuotedNoReply } from './jobs/drip';
import { rollUp } from './jobs/sequence-stats';
import { runRadar } from './jobs/radar';
import { leads } from './api/leads';
import { internal } from './api/internal';
import { platform } from './api/platform';
import { widget } from './api/widget';
import { flows } from './api/flows';
import { sequences } from './api/sequences';
import { settings } from './api/settings';
import { CHAT_JS } from './widget-asset';
import { MEDIA_TTL_MS, mintTicket, readTicket } from './ws-ticket';
import {
  COOKIE, clearCookie, createSession, destroySession, hashPassword,
  readCookie, readSession, sessionCookie, verifyPassword,
} from './auth';
import { CONSOLE_HTML } from './web-console';
import { sendEmail } from './lib/mailgun';
import { render as letter } from './lib/email-layout';

export { ChatSession } from './do/chat-session';
export { InboxRoom } from './do/inbox-room';
export type { Env, Job };

type Vars = { org: Org; sql: Sql; userId: string; role: 'sales' | 'admin' };
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

// Tenant provisioning. Outside /api because everything under /api resolves an org from the
// hostname first, which is the very thing this creates.
app.route('/platform', platform);

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
 * Inbound email from Mailgun.
 *
 * Authenticated by Mailgun's own signature rather than the operator token, since the caller
 * is Mailgun and cannot hold ours.
 */
app.post('/hooks/mailgun', async (c) => {
  const { status, body } = await mailgunInbound(c.req.raw, c.env, c.get('sql'), c.executionCtx);
  return c.json(body, status as 200);
});

// Delivery outcomes. Additive: they stamp timestamps onto messages a send already wrote,
// and are what make the opened / clicked / bounced branch conditions answerable.
app.post('/hooks/mailgun/events', (c) => mailgunEvents(c.req.raw, c.env, c.get('sql')));

/**
 * The website quote form. Posted to from the shop's own page, so it is cross-origin and
 * unauthenticated by necessity — the tenant's widget.allowed_domains is the gate, checked
 * before anything is written. `orgBySlug` here rather than resolveOrg: the hostname on this
 * request is the customer's website, not ours.
 */
const orgForSlug = (env: Env, sql: Sql) => async (slug: string) => {
  const [org] = await sql<Org[]>`
    SELECT id, slug, name, brand, comms, widget, features
      FROM orgs WHERE slug = ${slug} AND status = 'active'`;
  return org ?? null;
};
app.post('/hooks/form', (c) => formSubmit(c.req.raw, c.env, c.get('sql'), orgForSlug(c.env, c.get('sql'))));
app.options('/hooks/form', (c) => formOptions(c.req.raw, c.env, orgForSlug(c.env, c.get('sql'))));
app.post('/hooks/twilio/status', (c) => twilioStatus(c.req.raw, c.env, c.get('sql')));

/**
 * Inbound email over HTTP.
 *
 * The same handler Cloudflare Email Routing calls, reachable as a webhook so an inbound
 * provider can post here instead — and, more usefully day to day, so a raw .eml can be
 * pushed at it in a test without a domain, an MX record or a mailbox.
 *
 * The envelope recipient is a separate field rather than read from the headers, because a
 * bcc'd address is not in the headers at all.
 */
app.post('/hooks/email', async (c) => {
  if (c.req.header('x-internal-token') !== c.env.SESSION_SECRET) {
    return c.json({ error: 'operator token required' }, 403);
  }
  const to = c.req.query('to') ?? c.req.header('x-envelope-to') ?? '';
  const from = c.req.query('from') ?? c.req.header('x-envelope-from') ?? '';
  if (!to) return c.json({ error: 'envelope recipient required (?to=)' }, 400);

  const raw = await c.req.arrayBuffer();
  try {
    const out = await handleEmail({ to, from, raw }, c.env, c.get('sql'), c.executionCtx);
    return c.json(out, out.ok ? 200 : 202);   // 202: understood, deliberately not a ticket
  } catch (err) {
    // The caller holds the operator token, and a provider retrying a message forever because
    // all it ever sees is "Internal Server Error" is worse than telling it what broke.
    console.error('email hook failed', err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

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
      SELECT id, password_hash FROM users
       WHERE email = ${email} AND org_id = ${org.id} AND disabled_at IS NULL`);

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

/**
 * Signing in by email: a link to get in, and a link to set a new password.
 *
 * These routes sit above the /api/* middleware because that middleware authenticates and
 * nobody here can. They resolve the tenant from the hostname themselves, as /api/session
 * does. Both mint the same object — a secret mailed to an address, good once, briefly — and
 * differ only in what redeeming it does, so they share one table and one mint.
 *
 * The rules that carry the weight:
 *
 *  · The reply is identical whether or not the address has an account. Anything else turns
 *    this into a way to ask, from the open internet, which of a shop's staff exist.
 *  · Stored is the SHA-256 of the token, never the token: the mail is the only redeemable
 *    copy, so the table leaking grants nothing — the bargain password_hash already makes.
 *  · One use, and a fresh request cancels any earlier outstanding token of the same purpose,
 *    so a forwarded or shoulder-read older mail stops working.
 *  · The row names its org and redemption checks it against the hostname, so a token minted
 *    for one tenant cannot be spent on another sharing this Worker.
 *  · REDEMPTION IS A POST, NEVER A GET. Mail clients and security scanners fetch links in
 *    messages before anyone reads them; a link that signs you in on GET is a link that is
 *    already spent by the time it reaches the inbox. The link opens the app, and the app
 *    posts the token back.
 */
const LOGIN_TTL_MS = 15 * 60 * 1000;        // short: it is a door, not a password
const RESET_TTL_MS = 60 * 60 * 1000;        // longer: someone may go and find their password manager
// An invite is sent to somebody who is not waiting for it and may be away. Expiring it over
// a weekend turns a welcome into a support request on Monday.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

/** Mint a single-use token for this user, cancelling any outstanding one of that purpose. */
type Purpose = 'login' | 'invite' | 'reset';

async function mintToken(
  sql: Sql, purpose: Purpose, userId: string, orgId: string, ttlMs: number, ip: string | null,
): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  // Outside withOrg: auth_tokens carries no RLS policy, by design.
  await sql`DELETE FROM auth_tokens
             WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`;
  await sql`INSERT INTO auth_tokens (token_hash, purpose, user_id, org_id, expires_at, requested_ip)
            VALUES (${await sha256Hex(token)}, ${purpose}, ${userId}, ${orgId},
                    ${new Date(Date.now() + ttlMs)}, ${ip})`;
  return token;
}

/**
 * Redeem one, and say which way it failed when that can be said safely.
 *
 * 'spent' and 'stale' are only ever returned for a token this tenant actually minted, which
 * means whoever holds it already proved possession of the mailbox — there is nothing left to
 * leak by being specific, and "that link has expired" when someone has in fact already
 * signed in successfully sends them to ask an admin for help they do not need.
 *
 * 'unknown' stays deliberately vague: a token we have never seen, or one minted for another
 * tenant, is the case where a stranger is guessing, and they learn nothing from it.
 */
type Redeemed =
  | { ok: true; userId: string }
  | { ok: false; why: 'spent' | 'stale' | 'unknown' };

async function redeemToken(
  sql: Sql, purposes: Purpose[], token: string, orgId: string,
): Promise<Redeemed> {
  const hash = await sha256Hex(token);
  // jsonb, not a bound array: under fetch_types: false an array binds as a string literal
  // that matches nothing, and the row simply fails to be found — see SETUP-LOG.
  const [row] = await sql<{ user_id: string; org_id: string; used_at: string | null;
                           expired: boolean }[]>`
    SELECT user_id, org_id, used_at, (expires_at <= now()) AS expired
      FROM auth_tokens
     WHERE token_hash = ${hash}
       AND purpose IN (SELECT jsonb_array_elements_text(${sql.json(purposes)}::jsonb))`;

  if (!row || row.org_id !== orgId) return { ok: false, why: 'unknown' };
  if (row.used_at) return { ok: false, why: 'spent' };
  if (row.expired) return { ok: false, why: 'stale' };

  await sql`UPDATE auth_tokens SET used_at = now() WHERE token_hash = ${hash}`;
  return { ok: true, userId: row.user_id };
}

const WHY: Record<'spent' | 'stale' | 'unknown', string> = {
  spent: 'That link has already been used. If you are not signed in, ask for a new one below.',
  stale: 'That link has expired. Ask for a new one below and it will arrive in a moment.',
  unknown: 'That link is not valid. Ask for a new one below.',
};

/** The sender a tenant's mail goes out as — see replyByEmail for why it is derived. */
function mailFrom(org: Org, env: Env) {
  const sender = org.comms.email_sender || `${org.slug}@${env.MAILGUN_DOMAIN}`;
  return { from: `${org.name} <${sender}>`, replyTo: org.comms.email_inbound ?? sender };
}

/** The account behind an address on this tenant, if it can sign in at all. */
async function signInUser(sql: Sql, orgId: string, email: string) {
  const [user] = await withOrg(sql, orgId, (tx) =>
    tx<{ id: string; name: string }[]>`
      SELECT id, name FROM users
       WHERE email = ${email} AND org_id = ${orgId} AND disabled_at IS NULL`);
  return user ?? null;
}

app.post('/api/login-link', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const sql = c.get('sql');
  const url = new URL(c.req.url);
  // Same shape of answer for a missing field, an unknown tenant and an unknown account.
  if (!email) return c.json({ ok: true });
  const org = await resolveOrg(c.env, sql, url);
  if (!org) return c.json({ ok: true });

  const user = await signInUser(sql, org.id, email);
  if (user) {
    const token = await mintToken(sql, 'login', user.id, org.id, LOGIN_TTL_MS,
      c.req.header('cf-connecting-ip') ?? null);
    const { from, replyTo } = mailFrom(org, c.env);
    try {
      const mail = letter({
        variant: 'notice',
        heading: 'Your sign-in link',
        body: [
          `Hello ${user.name},`,
          `Here is your link to sign in to ${org.name} Front Desk.`,
        ],
        action: { label: 'Sign in', url: `${url.origin}/?login=${token}` },
        fine: 'It works once and expires in 15 minutes. If you did not ask to sign in, ignore '
            + 'this — the link does nothing on its own and nobody can use it without this message.',
      }, org, c.env);
      await sendEmail(c.env, {
        from, to: email, replyTo, inReplyTo: null, references: [],
        subject: `Your ${org.name} Front Desk sign-in link`,
        text: mail.text, html: mail.html,
      });
    } catch (err) {
      // Logged, not surfaced: saying the send failed would confirm the account exists.
      console.error('login link send failed', err);
    }
  }
  return c.json({ ok: true });
});

app.post('/api/login-link/consume', async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: string } | null;
  const token = body?.token?.trim();
  if (!token) return c.json({ error: 'token required' }, 400);

  const sql = c.get('sql');
  const url = new URL(c.req.url);
  const org = await resolveOrg(c.env, sql, url);
  if (!org) return c.json({ error: 'unknown tenant' }, 404);

  const r = await redeemToken(sql, ['login', 'invite'], token, org.id);
  if (!r.ok) return c.json({ error: WHY[r.why], why: r.why }, 400);
  const userId = r.userId;

  const { token: session, expires } = await createSession(
    sql, userId, org.id, c.req.header('user-agent') ?? null, c.req.header('cf-connecting-ip') ?? null);
  c.header('set-cookie', sessionCookie(session, expires, url.protocol === 'https:'));
  return c.json({ ok: true, userId });
});

app.post('/api/password-reset', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const sql = c.get('sql');
  const url = new URL(c.req.url);
  if (!email) return c.json({ ok: true });
  const org = await resolveOrg(c.env, sql, url);
  if (!org) return c.json({ ok: true });

  const user = await signInUser(sql, org.id, email);
  if (user) {
    const token = await mintToken(sql, 'reset', user.id, org.id, RESET_TTL_MS,
      c.req.header('cf-connecting-ip') ?? null);
    const { from, replyTo } = mailFrom(org, c.env);
    try {
      const mail = letter({
        variant: 'notice',
        heading: 'Set a new password',
        body: [
          `Hello ${user.name},`,
          `Someone asked to reset the password for this address on ${org.name} Front Desk.`,
        ],
        action: { label: 'Choose a new password', url: `${url.origin}/?reset=${token}` },
        fine: 'The link works once and expires in an hour. If that was not you, ignore this — '
            + 'your password has not changed, and nobody can use this link without the mail.',
      }, org, c.env);
      await sendEmail(c.env, {
        from, to: email, replyTo, inReplyTo: null, references: [],
        subject: `Reset your ${org.name} Front Desk password`,
        text: mail.text, html: mail.html,
      });
    } catch (err) {
      console.error('password reset send failed', err);
    }
  }
  return c.json({ ok: true });
});

app.post('/api/password-reset/confirm', async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: string; password?: string } | null;
  const token = body?.token?.trim();
  const password = body?.password;
  if (!token || !password) return c.json({ error: 'token and password required' }, 400);
  if (password.length < 12) return c.json({ error: 'password must be at least 12 characters' }, 400);

  const sql = c.get('sql');
  const url = new URL(c.req.url);
  const org = await resolveOrg(c.env, sql, url);
  if (!org) return c.json({ error: 'unknown tenant' }, 404);

  const r = await redeemToken(sql, ['reset'], token, org.id);
  if (!r.ok) return c.json({ error: WHY[r.why], why: r.why }, 400);
  const userId = r.userId;

  const newHash = await hashPassword(password);
  await withOrg(sql, org.id, (tx) => tx`
    UPDATE users SET password_hash = ${newHash}, password_set_at = now()
     WHERE id = ${userId} AND org_id = ${org.id}`);

  // End every existing session: a reset is what someone does when they suspect the account
  // is not only theirs.
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
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
      return roleOf(c, session.userId);
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
      return roleOf(c, user.id);
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
  return roleOf(c, user.id);
}

/**
 * Load the caller's role onto the request.
 *
 * Roles were stored and displayed but checked nowhere, which made them decorative: a sales
 * user could rewrite the messaging templates or publish a flow. Reading it once here means
 * every guarded route asks the same question of the same value.
 */
async function roleOf(c: Context<{ Bindings: Env; Variables: Vars }>, userId: string): Promise<Response | null> {
  const [row] = await withOrg(c.get('sql'), c.get('org').id, (tx) =>
    tx<{ role: 'sales' | 'admin'; disabled_at: string | null }[]>`
      SELECT role, disabled_at FROM users WHERE id = ${userId}`);
  if (!row) return c.json({ error: 'unknown user for tenant' }, 401);
  // A session outlives the account it belongs to, so this is where a disabled colleague is
  // actually stopped — not only at the login form.
  if (row.disabled_at) return c.json({ error: 'this account has been disabled' }, 403);
  c.set('role', row.role);
  return null;
}

/** Guard for anything that changes how the whole tenant works. */
function adminOnly(c: Context<{ Bindings: Env; Variables: Vars }>): Response | null {
  return c.get('role') === 'admin' ? null : c.json({ error: 'admins only' }, 403);
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
  // Two ways in: the platform operator token, which bootstraps the very first login before
  // any admin exists, or an admin of this tenant setting one for a colleague they added.
  const operator = c.env.SESSION_SECRET && c.req.header('x-admin-token') === c.env.SESSION_SECRET;
  if (!operator && c.get('role') !== 'admin') {
    return c.json({ error: 'admins only' }, 403);
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

/**
 * The org's people. Everyone may read the list — the assignee picker needs it — but only an
 * admin may change it. Disabled accounts are included so an admin can see and re-enable
 * them; the assignee picker filters them out on the client.
 */
app.get('/api/users', async (c) => {
  const org = c.get('org');
  const users = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string; name: string; email: string; role: string; disabled_at: string | null;
         last_seen_at: string | null; password_set_at: string | null;
         invited_at: string | null }[]>`
      SELECT id, name, email, role, disabled_at, last_seen_at, password_set_at, invited_at
        FROM users WHERE org_id = ${org.id}
       ORDER BY disabled_at NULLS FIRST, name`);
  return c.json({ users });
});

/**
 * Add a colleague.
 *
 * Created without a password: an account nobody can sign into yet is the safe default, and
 * the admin sets one through the same endpoint used to reset it. Email is unique across the
 * whole platform, not per tenant, so a clash is reported as such rather than as a 500.
 */
app.post('/api/users', async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const org = c.get('org');

  const body = await c.req.json().catch(() => null) as
    { name?: string; email?: string; role?: string } | null;
  const name = body?.name?.trim();
  const email = body?.email?.trim().toLowerCase();
  const role = body?.role;
  if (!name || !email) return c.json({ error: 'name and email are required' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'that is not an email address' }, 400);
  if (role !== 'sales' && role !== 'admin') return c.json({ error: 'role must be sales or admin' }, 400);

  // ON CONFLICT rather than a prior SELECT or a caught exception. users.email is unique
  // across the whole platform, so a SELECT inside this tenant's RLS context cannot see a
  // collision with another tenant and would report "available" right up to the insert
  // failing. The unique index is not RLS-filtered, so letting it decide is both correct and
  // free of any dependency on how a driver shapes its errors. It also declines to say which
  // tenant holds the address.
  const id = ulid();
  const [created] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string }[]>`
      INSERT INTO users (id, org_id, email, name, role, invited_by)
      VALUES (${id}, ${org.id}, ${email}, ${name}, ${role}::user_role, ${c.get('userId')})
      ON CONFLICT (email) DO NOTHING
      RETURNING id`);
  if (!created) return c.json({ error: 'that email address is already in use' }, 409);

  return c.json({ ok: true, user: { id, name, email, role, disabled_at: null } }, 201);
});

/** Change a colleague's name, role, or whether they can sign in. */
app.patch('/api/users/:id', async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const org = c.get('org');
  const id = c.req.param('id');
  const me = c.get('userId');

  const body = await c.req.json().catch(() => null) as
    { name?: string; role?: string; disabled?: boolean } | null;
  if (!body) return c.json({ error: 'nothing to change' }, 400);
  if (body.role && body.role !== 'sales' && body.role !== 'admin') {
    return c.json({ error: 'role must be sales or admin' }, 400);
  }

  // Locking yourself out, or removing the last admin, leaves a tenant nobody can administer
  // and no self-service way back in. Cheaper to refuse than to recover from.
  if (id === me && (body.disabled === true || body.role === 'sales')) {
    return c.json({ error: 'you cannot remove your own admin access' }, 400);
  }
  if (body.role === 'sales' || body.disabled === true) {
    const [{ n }] = await withOrg(c.get('sql'), org.id, (tx) =>
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users
                           WHERE org_id = ${org.id} AND role = 'admin' AND disabled_at IS NULL
                             AND id <> ${id}`);
    if (!n) return c.json({ error: 'that is the last admin — promote someone else first' }, 400);
  }

  const updated = await withOrg(c.get('sql'), org.id, async (tx) => {
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.role !== undefined) patch.role = body.role;
    if (body.disabled !== undefined) patch.disabled_at = body.disabled ? new Date().toISOString() : null;
    if (!Object.keys(patch).length) return null;

    const [row] = await tx<{ id: string; name: string; email: string; role: string; disabled_at: string | null }[]>`
      UPDATE users SET ${tx(patch)} WHERE id = ${id} AND org_id = ${org.id}
      RETURNING id, name, email, role, disabled_at`;
    return row ?? null;
  });
  if (!updated) return c.json({ error: 'not found' }, 404);

  // A disabled account keeps its rows but must not keep its way in.
  if (body.disabled === true) await c.get('sql')`DELETE FROM sessions WHERE user_id = ${id}`;

  return c.json({ ok: true, user: updated });
});

/**
 * Send someone their way in.
 *
 * An invite is a sign-in link with a longer life, mailed to a colleague who is not sitting
 * waiting for it. Redeeming one signs them in — there is no password to choose first, and
 * asking a new person to invent one before they have seen the thing is how accounts end up
 * sharing a password.
 *
 * Unlike /api/login-link, this one may say whether it worked: the caller is already an
 * authenticated admin of this tenant and can see the whole staff list anyway, so there is
 * nothing here to leak.
 */
async function sendInvite(
  c: Context<{ Bindings: Env; Variables: Vars }>, userId: string, email: string, name: string,
): Promise<{ sent: boolean; error?: string }> {
  const org = c.get('org');
  const sql = c.get('sql');
  const url = new URL(c.req.url);
  const token = await mintToken(sql, 'invite', userId, org.id, INVITE_TTL_MS,
    c.req.header('cf-connecting-ip') ?? null);

  const [inviter] = await withOrg(sql, org.id, (tx) =>
    tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${c.get('userId')}`);

  const { from, replyTo } = mailFrom(org, c.env);
  try {
    const mail = letter({
      variant: 'notice',
      heading: `You have been added to ${org.name} Front Desk`,
      body: [
        `Hello ${name},`,
        `${inviter?.name ?? 'An administrator'} has set you up on ${org.name} Front Desk — `
        + `where the shop's calls, texts, emails and website chats arrive as one queue.`,
      ],
      action: { label: 'Open Front Desk', url: `${url.origin}/?login=${token}` },
      fine: 'That link signs you in. It works once and lasts seven days; after that ask for a '
          + 'new one from the sign-in page. You do not need a password — you can set one later '
          + 'if you would rather.',
    }, org, c.env);
    await sendEmail(c.env, {
      from, to: email, replyTo, inReplyTo: null, references: [],
      subject: `${inviter?.name ?? 'Someone'} has added you to ${org.name} Front Desk`,
      text: mail.text, html: mail.html,
    });
    // Stamped after the send, not before: "Invited" has to mean a link actually left, or
    // the Team page tells an admin to wait on an email that was never delivered.
    await withOrg(sql, org.id, (tx) =>
      tx`UPDATE users SET invited_at = now() WHERE id = ${userId}`);
    return { sent: true };
  } catch (err) {
    // Surfaced, unlike the public routes: an admin who has just added a colleague needs to
    // know the welcome did not arrive, and there is nothing to leak to them.
    console.error('invite send failed', err);
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

app.post('/api/users/:id/invite', async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const org = c.get('org');
  const [user] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ id: string; email: string; name: string; disabled_at: string | null }[]>`
      SELECT id, email, name, disabled_at FROM users WHERE id = ${c.req.param('id')}`);
  if (!user) return c.json({ error: 'not found' }, 404);
  if (user.disabled_at) return c.json({ error: 'that account is disabled — enable it first' }, 409);

  const r = await sendInvite(c, user.id, user.email, user.name);
  if (!r.sent) return c.json({ error: `could not send the invite: ${r.error}` }, 502);
  return c.json({ ok: true, sent_to: user.email });
});

/**
 * Is each thing we depend on actually working?
 *
 * Every provider failure this product has had was silent: a truncated Twilio SID, a disabled
 * Mailgun key, a cancelled Mailgun subscription. All three were invisible because the code
 * that uses them is careful not to leak information when it fails — correct, and the reason
 * nobody noticed for days. This asks each one a harmless question and says what came back.
 *
 * Read-only by construction: it reads configuration, never sends a message or places a call.
 */
app.get('/api/health/providers', async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const env = c.env;
  const org = c.get('org');

  const check = async (name: string, detail: string, fn: () => Promise<string | null>) => {
    const started = Date.now();
    try {
      const problem = await fn();
      return { name, detail, ok: !problem, note: problem ?? 'Working', ms: Date.now() - started };
    } catch (err) {
      return { name, detail, ok: false, ms: Date.now() - started,
               note: err instanceof Error ? err.message : String(err) };
    }
  };

  const results = await Promise.all([
    check('Database', 'Postgres via Hyperdrive', async () => {
      const [row] = await c.get('sql')<{ n: number }[]>`SELECT 1 AS n`;
      return row?.n === 1 ? null : 'unexpected reply';
    }),

    check('Email', `Mailgun · ${env.MAILGUN_DOMAIN ?? '(no domain set)'}`, async () => {
      if (!env.MAILGUN_API_KEY) return 'MAILGUN_API_KEY is not set';
      if (!env.MAILGUN_DOMAIN) return 'MAILGUN_DOMAIN is not set';
      const base = env.MAILGUN_BASE_URL || 'https://api.mailgun.net';
      const r = await fetch(`${base}/v3/domains/${env.MAILGUN_DOMAIN}`, {
        headers: { authorization: 'Basic ' + btoa(`api:${env.MAILGUN_API_KEY}`) },
      });
      if (r.status === 401) return 'Key rejected — disabled, or wrong for this account';
      if (!r.ok) return `Mailgun returned ${r.status}`;
      const d = await r.json() as { domain?: { state?: string } };
      // "active" is not the same as "allowed to send": a cancelled subscription leaves the
      // domain active and refuses at send time. Worth saying which we actually checked.
      return d.domain?.state === 'active' ? null : `Domain state is ${d.domain?.state ?? 'unknown'}`;
    }),

    check('Text and voice', 'Twilio', async () => {
      if (!env.TWILIO_SID) return 'TWILIO_SID is not set';
      if (env.TWILIO_SID.length !== 34) return `TWILIO_SID is ${env.TWILIO_SID.length} characters, expected 34`;
      if (!env.TWILIO_AUTH_TOKEN) return 'TWILIO_AUTH_TOKEN is not set';
      if (env.TWILIO_AUTH_TOKEN.length !== 32) return `Auth token is ${env.TWILIO_AUTH_TOKEN.length} characters, expected 32`;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}.json`, {
        headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`) },
      });
      if (r.status === 401) return 'Credentials rejected';
      return r.ok ? null : `Twilio returned ${r.status}`;
    }),

    check('Files', 'R2 · artwork and voicemail', async () => {
      await env.FILES.head(`org/${org.id}/.healthcheck`);  // absent is fine; an error is not
      return null;
    }),

    check('Shop number', 'The number customers ring and text', async () =>
      org.comms.sms_number ? null : 'No SMS number set for this shop — replies cannot be sent'),

    check('Inbound email', 'Where forwarded enquiries arrive', async () => {
      if (!env.MAILGUN_SIGNING_KEY) return 'MAILGUN_SIGNING_KEY is not set — inbound mail is rejected unverified';
      return org.comms.email_inbound ? null : 'No intake address set for this shop';
    }),
  ]);

  return c.json({ checked_at: new Date().toISOString(), providers: results });
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

/**
 * Who may change what.
 *
 * Sales works the queue: read, reply, edit a spec, move a ticket, assign it. Anything that
 * changes how the tenant behaves for everyone — the bot's script, the voice and SMS copy —
 * is an admin decision. Reading those is open, so a sales user can see the flow their
 * conversations are following and simulate it, but not publish a change to it.
 */
app.use('/api/flows/*', async (c, next) => {
  const write = c.req.method !== 'GET' && !c.req.path.endsWith('/simulate');
  if (write) { const denied = adminOnly(c); if (denied) return denied; }
  await next();
});
app.use('/api/settings/*', async (c, next) => {
  if (c.req.method !== 'GET') { const denied = adminOnly(c); if (denied) return denied; }
  await next();
});

app.route('/api/flows', flows);
app.route('/api/sequences', sequences);
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

  /**
   * Cloudflare Email Routing delivers here. `message.to` is the envelope recipient, which is
   * the whole reason a bcc drop-box can work: that address was stripped from the headers
   * before the message ever left the sender's client.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const sql = connect(env);
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const out = await handleEmail({ to: message.to, from: message.from, raw }, env, sql, ctx);
      if (!out.ok) console.warn(`email: ${out.reason}`);
      else console.log(`email → ${out.ticket} (${out.direction}, ${out.attachments} files)`);
    } catch (err) {
      console.error('email: failed', err);
      // Rejecting tells the sender something went wrong rather than silently dropping a job.
      message.setReject('Could not process this message');
    } finally {
      ctx.waitUntil(sql.end());
    }
  },

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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Drips run straight from the cron rather than through the queue: the work is one row at
    // a time against Postgres, and a queue between the two would only add a way for a step
    // to be delivered twice.
    // Sweep for newly-eligible leads before sending, so a ticket that crossed the threshold
    // since the last run gets its first step on this pass rather than five minutes later.
    ctx.waitUntil((async () => {
      const sql = connect(env);
      try { await sweepQuotedNoReply(env, sql); } finally { await sql.end(); }
    })().catch((err) => console.error('quoted_no_reply sweep failed', err)));
    ctx.waitUntil(runDrips(env).then(
      (t) => console.log(`drip: ${t.sent} sent, ${t.held} held, ${t.stopped} stopped`),
      (err) => console.error('drip run failed', err)));
    // Once a night rather than every five minutes: the rollup reads the whole history of
    // every sequence, and nothing on the Performance tab changes minute to minute. The cron
    // fires every five minutes, so the hour is checked here.
    if (new Date().getUTCHours() === 7 && new Date().getUTCMinutes() < 5) {
      ctx.waitUntil((async () => {
        const sql = connect(env);
        try {
          // Radar first: a company flagged tonight should be chased tonight, and the rollup
          // then counts the enrolment it created.
          const r = await runRadar(env, sql);
          console.log(`radar: ${r.scanned} companies, ${r.flagged} flagged, ${r.enrolled} chased`);
          console.log(`stats: rolled up ${await rollUp(env, sql)} sequences`);
        } finally { await sql.end(); }
      })().catch((err) => console.error('nightly jobs failed', err)));
    }
    // leads WHERE status IN ('new','needs_info') AND created_at < now-2h → SLA nudge to InboxRoom
  },
} satisfies ExportedHandler<Env, Job>;
