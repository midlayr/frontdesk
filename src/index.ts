// Midlayr Front Desk · Worker entry
import { Hono } from 'hono';
import type { Env, Job, Org } from './env';
import { connect, withOrg, type Sql } from './db';
import { resolveOrg } from './org';
import { twilioSms } from './hooks/twilio-sms';
import { extractSpecs } from './jobs/extract-specs';
import { leads } from './api/leads';

export { ChatSession } from './do/chat-session';
export { InboxRoom } from './do/inbox-room';
export type { Env, Job };

type Vars = { org: Org; sql: Sql; userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

function isDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
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

// Webhooks resolve their own tenant (from the number dialled, not the hostname).
app.post('/hooks/twilio/sms', (c) => twilioSms(c.req.raw, c.env, c.executionCtx));

// Everything below is tenant-scoped by hostname.
app.use('/api/*', async (c, next) => {
  const org = await resolveOrg(c.env, c.get('sql'), new URL(c.req.url));
  if (!org) return c.json({ error: 'unknown tenant' }, 404);
  c.set('org', org);
  await next();
});

/**
 * Auth.
 *
 * Production sessions are still to do (signed cookie against SESSION_SECRET, users table).
 * Until then `x-dev-user: <users.id>` stands in — gated on a localhost hostname so it can
 * never authenticate a request to a deployed worker.
 */
app.use('/api/*', async (c, next) => {
  if (isDevHost(new URL(c.req.url).hostname)) {
    const devUser = c.req.header('x-dev-user');
    if (!devUser) return c.json({ error: 'x-dev-user required in dev' }, 401);

    const org = c.get('org');
    const [user] = await withOrg(c.get('sql'), org.id, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${devUser}`);
    if (!user) return c.json({ error: 'unknown user for tenant' }, 401);

    c.set('userId', user.id);
    return next();
  }

  return c.json({ error: 'session auth not implemented' }, 501);
});

app.get('/api/org', (c) => {
  const org = c.get('org');
  return c.json({ id: org.id, slug: org.slug, name: org.name, brand: org.brand, features: org.features });
});

app.route('/api/leads', leads);

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
