// POST /hooks/twilio/sms — inbound text → lead in the queue → extract_specs job
import { ulid } from 'ulid';
import type { Env } from '../index';
import { connect, withOrg, orgBySmsNumber, nextTicket } from '../db';

export async function twilioSms(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const p = Object.fromEntries(form) as Record<string, string>;
  if (!(await validTwilioSignature(req, p, env.TWILIO_AUTH_TOKEN))) return new Response('bad signature', { status: 403 });

  const sql = connect(env);
  const org = await orgBySmsNumber(sql, p.To);
  if (!org) return twiml(''); // unknown number: ack silently

  // A2P compliance: honor STOP/START ourselves too (Messaging Service handles the carrier side)
  const kw = (p.Body || '').trim().toUpperCase();
  if (['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(kw)) {
    await withOrg(sql, org.id, (tx) => tx`UPDATE contacts SET opted_out = true, opted_out_at = now() WHERE org_id = ${org.id} AND phone = ${p.From}`);
    await withOrg(sql, org.id, (tx) => tx`UPDATE enrollments e SET state = 'opted_out' FROM contacts c WHERE e.contact_id = c.id AND c.org_id = ${org.id} AND c.phone = ${p.From} AND e.state = 'active'`);
    return twiml('');
  }
  if (['START','UNSTOP','YES'].includes(kw)) {
    await withOrg(sql, org.id, (tx) => tx`UPDATE contacts SET opted_out = false, opted_out_at = null WHERE org_id = ${org.id} AND phone = ${p.From}`);
    return twiml('');
  }

  const { leadId, isNew } = await withOrg(sql, org.id, async (tx) => {
    // contact by phone
    let [contact] = await tx`SELECT id, company_id FROM contacts WHERE org_id = ${org.id} AND phone = ${p.From} LIMIT 1`;
    if (!contact) {
      [contact] = await tx`INSERT INTO contacts (id, org_id, phone, source) VALUES (${ulid()}, ${org.id}, ${p.From}, 'inbound') RETURNING id, company_id`;
    }
    // open lead on this thread in the last 7 days → append; else new ticket
    let [lead] = await tx`SELECT id FROM leads WHERE org_id = ${org.id} AND contact_id = ${contact.id} AND channel = 'sms'
      AND status NOT IN ('closed','won','lost','spam') AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`;
    let isNew = false;
    if (!lead) {
      isNew = true;
      const ticket = await nextTicket(tx, org.id);
      [lead] = await tx`INSERT INTO leads (id, org_id, ticket_no, contact_id, company_id, channel, status)
        VALUES (${ulid()}, ${org.id}, ${ticket}, ${contact.id}, ${contact.company_id}, 'sms', 'new') RETURNING id`;
      await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail) VALUES (${ulid()}, ${org.id}, ${lead.id}, 'system', 'lead.created', ${tx.json({ channel: 'sms' })})`;
    }
    await tx`INSERT INTO messages (id, lead_id, channel, direction, author, body, raw, provider_id)
      VALUES (${ulid()}, ${lead.id}, 'sms', 'in', 'visitor', ${p.Body}, ${tx.json(p)}, ${p.MessageSid}) ON CONFLICT (provider_id) DO NOTHING`;
    return { leadId: lead.id, isNew };
  });

  await env.JOBS.send({ kind: 'extract_specs', orgId: org.id, leadId });
  // Optional instant auto-reply on first inbound (drip trigger 'lead_created' handles the rest)
  const footer = org.comms.sms_footer ? ` ${org.comms.sms_footer}` : '';
  return twiml(isNew ? `Thanks — got it. ${org.name} will get back to you shortly with a price.${footer}` : '');
}

function twiml(msg: string) {
  const body = msg ? `<Response><Message>${escapeXml(msg)}</Message></Response>` : '<Response/>';
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { 'content-type': 'text/xml' } });
}
const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

async function validTwilioSignature(req: Request, params: Record<string, string>, token: string) {
  const sig = req.headers.get('X-Twilio-Signature'); if (!sig) return false;
  const url = new URL(req.url); url.protocol = 'https:';
  const data = url.toString() + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === sig;
}
