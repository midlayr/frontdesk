import { ulid } from 'ulid';
import type { Env, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { resolveOrgByPhone, ticketPrefix } from '../org';
import { verifySignature } from '../lib/twilio';

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { 'content-type': 'text/xml' } });

async function formParams(req: Request): Promise<Record<string, string>> {
  const form = await req.formData();
  const p: Record<string, string> = {};
  for (const [k, v] of form) p[k] = String(v);
  return p;
}

async function nextTicket(tx: Tx, org: Org): Promise<string> {
  const [row] = await tx<{ n: number }[]>`
    UPDATE counters SET next_ticket = next_ticket + 1
     WHERE org_id = ${org.id} RETURNING next_ticket - 1 AS n`;
  if (!row) throw new Error(`no counters row for org ${org.id}`);
  return `${ticketPrefix(org)}-${row.n}`;
}

async function findOrCreateContact(tx: Tx, orgId: string, phone: string): Promise<string> {
  const [found] = await tx<{ id: string }[]>`
    SELECT id FROM contacts WHERE org_id = ${orgId} AND phone = ${phone} LIMIT 1`;
  if (found) return found.id;
  const id = ulid();
  await tx`INSERT INTO contacts (id, org_id, phone, source) VALUES (${id}, ${orgId}, ${phone}, 'inbound')`;
  return id;
}

/**
 * POST /hooks/twilio/voice — someone rang the shop.
 *
 * Answer, say who we are in the tenant's own words, and record. Twilio posts the finished
 * recording to /hooks/twilio/recording, which is where the real work happens: this handler
 * has to reply with TwiML fast or the caller hears silence.
 */
export async function twilioVoice(req: Request, env: Env, sql: Sql): Promise<Response> {
  const params = await formParams(req);
  const to = params.To;
  if (!to) return new Response('missing To', { status: 400 });

  const org = await resolveOrgByPhone(env, sql, to);
  if (!org) return new Response('no tenant for that number', { status: 404 });

  const ok = await verifySignature(env.TWILIO_AUTH_TOKEN, req.url, params, req.headers.get('x-twilio-signature'));
  if (!ok) return new Response('bad signature', { status: 403 });

  const greeting = (org.comms as { voice_greeting?: string }).voice_greeting
    ?? `Thanks for calling ${org.name}. Nobody is free right now — leave the details of your job after the tone and we'll come straight back to you.`;

  const action = new URL('/hooks/twilio/recording', req.url).toString();

  return xml(
    `<Response>` +
      `<Say voice="Polly.Joanna">${greeting.replace(/[<&]/g, '')}</Say>` +
      `<Record action="${action}" method="POST" maxLength="180" playBeep="true" trim="trim-silence" transcribe="false"/>` +
      // reached only if they hang up without recording
      `<Say voice="Polly.Joanna">We didn't catch that. Please call back or text us. Goodbye.</Say>` +
    `</Response>`,
  );
}

/**
 * POST /hooks/twilio/recording — the voicemail itself.
 *
 * Pull the audio from Twilio, put it in R2 under the tenant's prefix, open a ticket, and
 * queue transcription. The audio is fetched here rather than left as a Twilio URL so the
 * recording survives us deleting it from Twilio, and so playback needs no Twilio credentials.
 */
export async function twilioRecording(req: Request, env: Env, sql: Sql, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const params = await formParams(req);
  const { From: from, To: to, RecordingUrl: recordingUrl, RecordingSid: recordingSid } = params;
  const duration = Number(params.RecordingDuration ?? '0');

  if (!from || !to || !recordingUrl) return new Response('missing fields', { status: 400 });

  const org = await resolveOrgByPhone(env, sql, to);
  if (!org) return new Response('no tenant for that number', { status: 404 });

  const ok = await verifySignature(env.TWILIO_AUTH_TOKEN, req.url, params, req.headers.get('x-twilio-signature'));
  if (!ok) return new Response('bad signature', { status: 403 });

  // A hang-up with no words is not a lead.
  if (duration < 2) return xml('<Response><Say voice="Polly.Joanna">Goodbye.</Say></Response>');

  const messageId = ulid();
  const key = `org/${org.id}/voicemail/${messageId}.mp3`;

  const audio = await fetch(`${recordingUrl}.mp3`, {
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`) },
  });
  if (!audio.ok) {
    console.error(`voicemail: could not fetch recording ${recordingSid}: ${audio.status}`);
    return xml('<Response/>');
  }
  await env.FILES.put(key, audio.body, { httpMetadata: { contentType: 'audio/mpeg' } });

  const leadId = await withOrg(sql, org.id, async (tx) => {
    if (recordingSid) {
      const [dupe] = await tx<{ lead_id: string }[]>`
        SELECT lead_id FROM messages WHERE provider_id = ${recordingSid} LIMIT 1`;
      if (dupe) return null;
    }

    const contactId = await findOrCreateContact(tx, org.id, from);
    const [open] = await tx<{ id: string }[]>`
      SELECT id FROM leads
       WHERE org_id = ${org.id} AND contact_id = ${contactId}
         AND status NOT IN ('won','lost','closed','spam')
       ORDER BY created_at DESC LIMIT 1`;

    let id: string;
    if (open) {
      id = open.id;
    } else {
      id = ulid();
      const ticketNo = await nextTicket(tx, org);
      await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, channel, status)
               VALUES (${id}, ${org.id}, ${ticketNo}, ${contactId}, 'voice', 'new')`;
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
               VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'lead_created',
                       ${tx.json({ channel: 'voice', ticket_no: ticketNo, from })})`;
    }

    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, raw,
                                   audio_r2_key, transcript_status, provider_id)
             VALUES (${messageId}, ${id}, 'voice', 'in', 'visitor', NULL, ${tx.json(params)},
                     ${key}, 'pending', ${recordingSid ?? null})
             ON CONFLICT (provider_id) WHERE provider_id IS NOT NULL DO NOTHING`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${org.id}, ${id}, 'system', 'voicemail_received',
                     ${tx.json({ seconds: duration, recording_sid: recordingSid ?? null })})`;
    return id;
  });

  if (leadId) {
    ctx.waitUntil(env.JOBS.send({ kind: 'transcribe', orgId: org.id, messageId }));
  }

  return xml('<Response><Say voice="Polly.Joanna">Got it — thanks. We\'ll be in touch shortly. Goodbye.</Say></Response>');
}
