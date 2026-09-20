import { ulid } from 'ulid';
import type { Env, Org } from '../env';
import { withOrg, type Sql, type Tx } from '../db';
import { resolveOrgByPhone, ticketPrefix } from '../org';
import { findThreadableLead } from '../lib/threading';
import { verifySignature } from '../lib/twilio';
import { messagingFor, render, xmlEscape } from '../lib/messaging';

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

  const { voice } = messagingFor(org);
  const vars = { org: org.name };
  const action = new URL('/hooks/twilio/recording', req.url).toString();

  return xml(
    `<Response>` +
      `<Say voice="Polly.Joanna">${xmlEscape(render(voice.greeting, vars))}</Say>` +
      `<Record action="${action}" method="POST" maxLength="${voice.max_seconds}" playBeep="true" trim="trim-silence" transcribe="false"/>` +
      // reached only if they hang up without recording
      `<Say voice="Polly.Joanna">${xmlEscape(render(voice.no_input, vars))}</Say>` +
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

  // Buffered, not streamed: R2 needs a known length and Twilio sends the recording without
  // a content-length, which makes put() throw on the stream. Recording is capped at 180s
  // above, so this is a couple of MB at worst.
  const bytes = await audio.arrayBuffer();
  if (bytes.byteLength === 0) {
    console.error(`voicemail: empty recording ${recordingSid}`);
    return xml('<Response/>');
  }
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } });

  const leadId = await withOrg(sql, org.id, async (tx) => {
    if (recordingSid) {
      const [dupe] = await tx<{ lead_id: string }[]>`
        SELECT lead_id FROM messages WHERE provider_id = ${recordingSid} LIMIT 1`;
      if (dupe) return null;
    }

    const contactId = await findOrCreateContact(tx, org.id, from);
    // Same conversation only while it is still warm — see lib/threading.
    const openId = await findThreadableLead(tx, org.id, contactId);

    let id: string;
    if (openId) {
      id = openId;
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

  const { voice } = messagingFor(org);
  return xml(`<Response><Say voice="Polly.Joanna">${xmlEscape(render(voice.after_record, { org: org.name }))}</Say></Response>`);
}
