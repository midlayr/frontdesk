import type { Env } from '../env';

/**
 * Mailgun, in and out.
 *
 * Inbound arrives as a Route webhook rather than as mail, which means two things matter more
 * than the parsing: the request is signed and must be verified, and the envelope recipient
 * comes as its own `recipient` field — which is exactly what a bcc drop-box needs, since
 * that address is nowhere in the headers.
 */

const FRESH_MS = 5 * 60_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Verify a Mailgun webhook: HMAC-SHA256 of `timestamp + token`, keyed with the signing key.
 *
 * The timestamp is checked as well as the signature. A signature alone is replayable
 * forever, and a replayed route post is a duplicate ticket — or, with a captured message,
 * an attacker's chosen content in someone's queue.
 */
export async function verifyMailgun(
  signingKey: string, timestamp: string, token: string, signature: string, now = Date.now(),
): Promise<boolean> {
  if (!signingKey || !timestamp || !token || !signature) return false;

  const age = Math.abs(now - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > FRESH_MS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + token));
  return timingSafeEqual(hex(mac), signature.toLowerCase());
}

export interface Outgoing {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Where the customer's reply should go — our inbound address, so it threads back. */
  replyTo?: string | null;
  /** Threading: the message we are answering, so the customer's client nests the reply. */
  inReplyTo?: string | null;
  references?: string[];
}

export interface Sent { id: string }

/**
 * Send through Mailgun.
 *
 * The returned Message-ID is stored on the message row, which is what lets the customer's
 * reply thread back onto this ticket through In-Reply-To.
 */
export async function sendEmail(env: Env, m: Outgoing): Promise<Sent> {
  const domain = env.MAILGUN_DOMAIN;
  if (!domain) throw new Error('MAILGUN_DOMAIN is not set');
  if (!env.MAILGUN_API_KEY) throw new Error('MAILGUN_API_KEY is not set');

  const form = new FormData();
  form.set('from', m.from);
  form.set('to', m.to);
  form.set('subject', m.subject);
  form.set('text', m.text);
  if (m.replyTo) form.set('h:Reply-To', m.replyTo);
  if (m.inReplyTo) form.set('h:In-Reply-To', m.inReplyTo);
  if (m.references?.length) form.set('h:References', m.references.join(' '));

  const base = env.MAILGUN_BASE_URL || 'https://api.mailgun.net';
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`mailgun ${res.status}: ${text.slice(0, 300)}`);

  // Mailgun returns the id with angle brackets already; store it exactly as it will appear
  // in the customer's In-Reply-To, or threading quietly stops matching.
  const id = (JSON.parse(text) as { id?: string }).id ?? '';
  return { id };
}
