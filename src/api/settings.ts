import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { defaults, messagingFor } from '../lib/messaging';
import { invalidateOrg } from '../org';

type Vars = { org: Org; sql: Sql; userId: string };

export const settings = new Hono<{ Bindings: Env; Variables: Vars }>();

const MessagingBody = z.object({
  voice: z.object({
    greeting: z.string().min(1).max(1200),
    after_record: z.string().min(1).max(600),
    no_input: z.string().min(1).max(600),
    // Twilio's own ceiling; longer voicemails are rarely useful anyway.
    max_seconds: z.number().int().min(10).max(600),
  }),
  sms: z.object({
    auto_reply_enabled: z.boolean(),
    // 320 keeps an auto-reply plus a signature inside two segments.
    auto_reply: z.string().max(320),
    signature: z.string().max(160),
  }),
});

/** What is said today, with the platform defaults alongside so the editor can offer a reset. */
settings.get('/messaging', (c) => {
  const org = c.get('org');
  return c.json({
    messaging: messagingFor(org),
    defaults: defaults(org.name),
    tokens: { org: org.name, ticket: 'DL-2046' },
  });
});

settings.put('/messaging', async (c) => {
  const org = c.get('org');
  const parsed = MessagingBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad settings', detail: parsed.error.issues }, 400);

  await withOrg(c.get('sql'), org.id, async (tx) => {
    // Merged into comms rather than replacing it: sms_number, email_from and the rest live
    // in the same column and must survive a settings save.
    await tx`UPDATE orgs
                SET comms = (comms - 'voice_greeting')
                         || jsonb_build_object('messaging', ${tx.json(parsed.data)}::jsonb)
              WHERE id = ${org.id}`;
  });

  // The org row is KV-cached under several keys for tenant resolution — hostname, the
  // platform subdomain, and the SMS number. Clear all of them, or a save looks like it did
  // nothing for up to a minute.
  await invalidateOrg(c.env, c.get('sql'), org);

  return c.json({ ok: true, messaging: parsed.data });
});
