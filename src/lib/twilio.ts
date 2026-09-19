import type { Env } from '../env';

const enc = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Twilio signs HMAC-SHA1 over the exact webhook URL followed by every POST field,
 * sorted by key and concatenated as key+value.
 *
 * The URL must be the one Twilio was configured with. Behind Cloudflare, req.url is
 * already the public URL; if you ever front this with a proxy that rewrites scheme or
 * host, sign against the original instead or every request will 403.
 */
export async function verifySignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

export interface SentSms {
  sid: string;
  status: string;
}

/** Send an SMS from the tenant's own number. `from` always comes from org.comms.sms_number. */
export async function sendSms(env: Env, from: string, to: string, body: string): Promise<SentSms> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });

  const json = (await res.json()) as { sid?: string; status?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`twilio ${res.status}: ${json.message ?? 'send failed'} (code ${json.code ?? '?'})`);
  return { sid: json.sid!, status: json.status ?? 'queued' };
}

/** Twilio expects TwiML; an empty <Response/> means "accepted, say nothing back". */
export function emptyTwiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    headers: { 'content-type': 'text/xml' },
  });
}
