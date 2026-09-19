/**
 * Short-lived tickets for authenticating WebSockets.
 *
 * A browser cannot set headers on a WebSocket, and a long-lived secret must never travel in
 * a URL — it lands in logs, proxies and Referer headers. So a normal authenticated request
 * mints a ticket that is scoped to one tenant and user and expires in a minute, and that is
 * what goes in the query string.
 */
const enc = new TextEncoder();
const TTL_MS = 60_000;

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export async function mintTicket(secret: string, orgId: string, userId: string): Promise<string> {
  const exp = Date.now() + TTL_MS;
  const payload = `${orgId}.${userId}.${exp}`;
  return `${userId}.${exp}.${await sign(secret, payload)}`;
}

/** Returns the user id the ticket is good for, or null. */
export async function readTicket(secret: string, orgId: string, ticket: string): Promise<string | null> {
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [userId, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;

  const expected = await sign(secret, `${orgId}.${userId}.${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? userId : null;
}
