// Midlayr Front Desk · Worker entry
import { Hono } from 'hono';
import { connect, resolveOrg, type Org } from './db';
import { twilioSms } from './hooks/twilio-sms';
import { extractSpecs } from './jobs/extract-specs';
import { leads } from './api/leads';
export { ChatSession } from './do/chat-session';
export { InboxRoom } from './do/inbox-room';

export interface Env {
  HYPERDRIVE: Hyperdrive; FILES: R2Bucket; CONFIG: KVNamespace; JOBS: Queue<Job>; AI: Ai;
  CHAT_SESSION: DurableObjectNamespace; INBOX_ROOM: DurableObjectNamespace;
  TWILIO_SID: string; TWILIO_AUTH_TOKEN: string; RESEND_API_KEY: string; SESSION_SECRET: string; PLATFORM_DOMAIN: string;
}
export type Job = { orgId: string } & (
  | { kind: 'transcribe'; messageId: string }
  | { kind: 'extract_specs'; leadId: string }
  | { kind: 'score_intent'; leadId: string }
  | { kind: 'enrich'; contactId: string }
  | { kind: 'import_rows'; importId: string; offset: number }
  | { kind: 'drip_send'; enrollmentId: string });

type Vars = { org: Org; userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// webhooks resolve tenant from payload, not hostname
app.post('/hooks/twilio/sms', (c) => twilioSms(c.req.raw, c.env));
// app.post('/hooks/twilio/voice', …)   app.post('/hooks/email', …)   app.post('/api/form', …)

// tenant + auth for everything under /api
app.use('/api/*', async (c, next) => {
  const org = await resolveOrg(c.env, connect(c.env), new URL(c.req.url).hostname);
  if (!org) return c.text('unknown tenant', 404);
  c.set('org', org);
  // TODO: session cookie → users row (must belong to org) · for now a dev header
  const userId = c.req.header('x-dev-user'); if (!userId) return c.text('unauthorized', 401);
  c.set('userId', userId);
  await next();
});
app.get('/api/org', (c) => { const { id, slug, name, brand, features, hours } = c.get('org'); return c.json({ id, slug, name, brand, features, hours }); });
app.route('/api/leads', leads);
// app.route('/api/flows', flows)  app.route('/api/sequences', sequences)  app.route('/api/imports', imports)
// app.get('/widget/config', …)    app.get('/widget/session', …)  app.get('/api/inbox/stream', …)

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<Job>, env: Env) {
    for (const m of batch.messages) {
      try {
        const j = m.body;
        if (j.kind === 'extract_specs') await extractSpecs(env, j.orgId, j.leadId);
        // else if (j.kind === 'transcribe') … Whisper → messages.body → JOBS.extract_specs
        // else if (j.kind === 'score_intent') … else if (j.kind === 'drip_send') …
        m.ack();
      } catch (e) { console.error(m.body.kind, e); m.retry(); }
    }
  },
  async scheduled(_: ScheduledEvent, env: Env) {
    // enrollments WHERE state='active' AND next_send_at <= now() → JOBS.drip_send
    // leads WHERE status IN ('new','needs_info') AND created_at < now()-'2h' → InboxRoom SLA nudge
  },
};
