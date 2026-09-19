// Dumont Front Desk · Worker entry · route skeleton only
export { ChatSession } from './do/chat-session';
export { InboxRoom } from './do/inbox-room';

export interface Env {
  HYPERDRIVE: Hyperdrive; FILES: R2Bucket; CONFIG: KVNamespace; JOBS: Queue<Job>; AI: Ai;
  CHAT_SESSION: DurableObjectNamespace; INBOX_ROOM: DurableObjectNamespace;
  TWILIO_AUTH_TOKEN: string; RESEND_API_KEY: string; SESSION_SECRET: string;
}
export type Job =
  | { kind: 'transcribe'; messageId: string }          // R2 audio → Whisper → messages.body
  | { kind: 'extract_specs'; leadId: string }         // body → product/qty/size/stock… + confidence
  | { kind: 'score_intent'; leadId: string }
  | { kind: 'enrich'; contactId: string }
  | { kind: 'import_rows'; importId: string; offset: number }
  | { kind: 'drip_send'; enrollmentId: string };

// Tenant resolution runs before every route: hostname → org_domains → org (cached in KV 60s).
// Fallback: <slug>.midlayr.app. The resolved org's brand/comms/widget JSON is attached to the request
// and drives the theme, the From address, the SMS number, and the widget config.
// Platform users (Midlayr staff) authenticate against platform_users and pick a tenant explicitly.
const routes: [string, RegExp, string][] = [
  // inbound channels (webhooks)
  ['POST', /^\/hooks\/twilio\/voice$/,   'voicemail → lead + message(audio) → JOBS.transcribe'],
  ['POST', /^\/hooks\/twilio\/sms$/,     'sms in → find/create lead by phone → JOBS.extract_specs'],
  ['POST', /^\/hooks\/email$/,           'forwarded quotes@ inbox → lead + attachments → JOBS.extract_specs'],
  ['POST', /^\/api\/form$/,              'dumontprinting.com order form → lead (already structured)'],
  // Midlayr Chat widget (public, CORS to allowed domains from CONFIG)
  ['GET',  /^\/widget\/config$/,         'published flow + tenant brand/widget settings from KV (per hostname)'],
  // platform admin (Midlayr only)
  ['CRUD', /^\/platform\/orgs/,          'create tenant, set brand/comms/features, attach custom hostnames via Cloudflare for SaaS'],
  ['GET',  /^\/widget\/session$/,        'upgrade → ChatSession DO websocket'],
  // app API (session cookie auth)
  ['GET',  /^\/api\/leads$/,             'queue: ?status&assignee&q · sorted live→rush→deadline'],
  ['GET',  /^\/api\/leads\/:id$/,        'ticket + messages + attachments + activity'],
  ['PATCH',/^\/api\/leads\/:id$/,        'inline spec edit → recompute missing_fields/status, log activity'],
  ['POST', /^\/api\/leads\/:id\/reply$/, 'send on lead.channel (Twilio/Resend) → status replied, first_reply_at'],
  ['POST', /^\/api\/leads\/:id\/takeover$/, 'rep joins ChatSession DO, state=live'],
  ['GET',  /^\/api\/inbox\/stream$/,     'upgrade → InboxRoom DO (new-lead / status pushes)'],
  ['GET|PUT', /^\/api\/flows\/:slug$/,   'flow builder read/save → bump version, write KV on publish'],
  ['CRUD', /^\/api\/sequences/,          'drip sequences + steps'],
  ['POST', /^\/api\/imports$/,           'CSV → R2 → JOBS.import_rows → JOBS.enrich per contact'],
  ['GET',  /^\/api\/files\/:id$/,        'signed R2 read'],
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // db(): `import postgres from 'postgres'; const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5 })`
    // per request: await sql`SET LOCAL app.org_id = ${orgId}` inside a transaction → RLS scopes every query
    // TODO: router (hono recommended) + auth middleware
    return new Response(JSON.stringify(routes.map(r => r[0] + ' ' + r[1].source + ' — ' + r[2]), null, 2), { headers: { 'content-type': 'application/json' } });
  },
  async queue(batch: MessageBatch<Job>, env: Env) {
    for (const m of batch.messages) {
      // switch (m.body.kind) { case 'transcribe': … env.AI.run('@cf/openai/whisper', …) }
      m.ack();
    }
  },
  async scheduled(_: ScheduledEvent, env: Env) {
    // enrollments WHERE state='active' AND next_send_at <= now → JOBS.drip_send
    // leads WHERE status IN ('new','needs_info') AND created_at < now-2h → SLA nudge to InboxRoom
  },
};
