import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { TTS_VOICES, defaults, isTtsVoice, messagingFor, render, xmlEscape } from '../lib/messaging';
import { ulid } from 'ulid';
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
    // Validated against the list rather than accepted as free text: an unknown voice makes
    // Twilio reject the TwiML and the caller hears silence.
    tts_voice: z.string().refine(isTtsVoice, 'unknown voice'),
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
    voices: TTS_VOICES,
  });
});

const Preview = z.object({
  to: z.string().regex(/^\+1\d{10}$/, 'must be a US or Canadian number in +1XXXXXXXXXX form'),
  voice: z.string().refine(isTtsVoice, 'unknown voice'),
  text: z.string().min(1).max(600),
});

/**
 * Ring the rep and speak the greeting in the selected voice.
 *
 * Twilio has no standalone synthesis endpoint, and the browser's speechSynthesis uses the
 * operating system's voices — nothing like Polly — so a local preview would be actively
 * misleading about what callers hear. An actual call is the only faithful preview.
 *
 * Placing calls is a toll-fraud vector, so: a session is required, the destination is capped
 * to +1, the TwiML says one line and hangs up, and every preview is written to activity with
 * the user who asked for it.
 */
settings.post('/messaging/preview', async (c) => {
  const org = c.get('org');
  const parsed = Preview.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
  const { to, voice, text } = parsed.data;

  const from = org.comms.sms_number;
  if (!from) return c.json({ error: 'this tenant has no phone number configured' }, 400);

  const twiml = `<Response><Say voice="${voice}">${xmlEscape(render(text, { org: org.name }))}</Say></Response>`;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.env.TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${c.env.TWILIO_SID}:${c.env.TWILIO_AUTH_TOKEN}`),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Twiml: twiml }),
  });

  const json = (await res.json()) as { sid?: string; message?: string; code?: number };
  if (!res.ok) return c.json({ error: json.message ?? 'Twilio refused the call', code: json.code }, 502);

  await withOrg(c.get('sql'), org.id, async (tx) => {
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, NULL, ${c.get('userId')}, 'voice_preview',
                     ${tx.json({ to, voice, call_sid: json.sid ?? null })})`;
  });

  return c.json({ ok: true, call_sid: json.sid });
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
