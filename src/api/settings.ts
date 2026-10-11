import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Org } from '../env';
import { withOrg, type Sql } from '../db';
import { TTS_VOICES, defaults, isTtsVoice, messagingFor, render, xmlEscape } from '../lib/messaging';
import { ulid } from 'ulid';
import { invalidateOrg } from '../org';
import { cleanDomains } from '../lib/domains';
import { describe as describeHours, hoursKey, hoursOf, openAt } from '../lib/hours';

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

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The tenant's palette.
 *
 * Only the four colours a shop actually has an opinion about. Everything else in tokens.css
 * is derived or structural, and letting someone set `--line` to crimson produces a mess no
 * one asked for. Hex is validated rather than trusted: these values are written straight
 * into a style property, so anything accepted here ends up in the page.
 */
const BrandBody = z.object({
  color: z.string().regex(HEX, 'use a 6-digit hex colour').optional(),
  ink: z.string().regex(HEX, 'use a 6-digit hex colour').optional(),
  paper: z.string().regex(HEX, 'use a 6-digit hex colour').optional(),
  app_name: z.string().min(1).max(60).optional(),
});

settings.get('/brand', (c) => {
  const b = c.get('org').brand as Record<string, unknown>;
  return c.json({
    brand: {
      color: b.color ?? '#0B7FA8',
      ink: b.ink ?? '#14161A',
      paper: b.paper ?? '#FBFAF8',
      app_name: b.app_name ?? `${c.get('org').name} · Front Desk`,
    },
  });
});

settings.put('/brand', async (c) => {
  const org = c.get('org');
  const parsed = BrandBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad brand', detail: parsed.error.issues }, 400);

  const saved = await withOrg(c.get('sql'), org.id, async (tx) => {
    // Merged rather than replaced: brand also holds the logo keys, ticket prefix and bot
    // name, none of which this editor knows about and all of which a replace would drop.
    const [row] = await tx<{ brand: Record<string, unknown> }[]>`
      UPDATE orgs SET brand = brand || ${tx.json(parsed.data)}::jsonb
       WHERE id = ${org.id} RETURNING brand`;
    return row?.brand ?? null;
  });

  // Without this the saved colour appears to do nothing for up to a minute, which reads as
  // a broken Save button — the same trap the messaging editor hit.
  await invalidateOrg(c.env, c.get('sql'), org);
  return c.json({ ok: true, brand: saved });
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

/**
 * Where the shop's bots and forms are allowed to run.
 *
 * This list is the gate on two public, unauthenticated endpoints — /widget/config and
 * /hooks/form — so it is the one piece of install configuration that can make a correct
 * script tag do nothing at all. The browser's error is a CORS message in the console of the
 * shop's own website, which nobody in this app will ever see. Before this it could only be
 * changed with SQL, which meant every install needed us.
 *
 * Org-level rather than per-bot, matching where the check reads it from: a bot cannot be
 * allowed to widen it (see lib/flow-settings).
 */
const Domains = z.object({ allowed_domains: z.array(z.string().max(253)).max(25) });

settings.put('/widget', async (c) => {
  const org = c.get('org');
  const parsed = Domains.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad domains', detail: parsed.error.issues }, 400);

  const { domains: cleaned, rejected } = cleanDomains(parsed.data.allowed_domains);

  const saved = await withOrg(c.get('sql'), org.id, async (tx) => {
    // Merged, like brand: widget also holds the launcher, nudge and position, and a replace
    // would quietly drop all three.
    const [row] = await tx<{ widget: Record<string, unknown> }[]>`
      UPDATE orgs SET widget = widget || ${tx.json({ allowed_domains: cleaned })}::jsonb
       WHERE id = ${org.id} RETURNING widget`;
    return row?.widget ?? null;
  });

  // The allowlist is read from the cached org on every widget config call, so without this
  // a domain added here keeps being refused for up to a minute.
  await invalidateOrg(c.env, c.get('sql'), org);

  const domains = (saved as { allowed_domains?: unknown } | null)?.allowed_domains;
  return c.json({
    ok: true,
    allowed_domains: Array.isArray(domains) ? domains : cleaned,
    // Reported rather than silently dropped: "I added it and it is not in the list" is a
    // worse outcome than being told the value made no sense.
    rejected,
  });
});

/**
 * When the shop is open.
 *
 * Read by the chat bot, to decide which closing line a visitor gets, and by the campaign
 * sender, which has always had its own copy of this idea. One set of hours, one answer.
 */
const HoursBody = z.object({
  days: z.array(z.number().int().min(1).max(7)).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a 24-hour time like 08:30'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a 24-hour time like 17:00'),
  tz: z.string().min(1).max(64),
});

settings.get('/hours', (c) => {
  const h = hoursOf((c.get('org').comms as { hours?: unknown }).hours);
  return c.json({ hours: h, described: describeHours(h), open: openAt(h) });
});

settings.put('/hours', async (c) => {
  const org = c.get('org');
  const parsed = HoursBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'bad hours' }, 400);
  }
  const h = parsed.data;
  // Closing before opening is not a short day, it is a typo that would shut the shop
  // permanently — and the symptom would be customers quietly getting the wrong message.
  if (h.start >= h.end) return c.json({ error: 'the closing time has to be after the opening time' }, 400);
  // Rejected rather than accepted and silently ignored: Intl is the only thing that knows
  // which zone names are real, so ask it.
  try { new Intl.DateTimeFormat('en-US', { timeZone: h.tz }); }
  catch { return c.json({ error: `"${h.tz}" is not a time zone I recognise` }, 400); }

  const hours = hoursOf({ ...h, days: [...new Set(h.days)].sort((a, b) => a - b) });

  await withOrg(c.get('sql'), org.id, (tx) =>
    tx`UPDATE orgs SET comms = comms || ${tx.json({
         hours: { days: hours.days, start: hours.start, end: hours.end, tz: hours.tz },
       })}::jsonb WHERE id = ${org.id}`);

  /*
   * Also to KV, which is the copy the chat bot actually reads: a Durable Object has no
   * database binding. Written after the row, so a failure here leaves the stored hours
   * right and the bot a minute behind, rather than the other way round.
   */
  await c.env.CONFIG.put(hoursKey(org.id), JSON.stringify(hours));
  await invalidateOrg(c.env, c.get('sql'), org);

  return c.json({ ok: true, hours, described: describeHours(hours), open: openAt(hours) });
});
