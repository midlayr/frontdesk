import type { Sql } from './db';

/**
 * Passwords and sessions.
 *
 * PBKDF2-HMAC-SHA256, because it is the only password KDF WebCrypto gives a Worker — no
 * bcrypt, no argon2. Workers refuses more than 100,000 iterations per call
 * ("iteration counts above 100000 are not supported"), which is below current guidance for
 * this construction, so the work factor is built by chaining rounds: each round re-derives
 * from the previous output. Three rounds of 100k is 300k iterations of equivalent work.
 *
 * Both numbers are stored with the hash, so they can be raised later without invalidating
 * anyone's existing password.
 */

const enc = new TextEncoder();
const ITERATIONS = 100_000;   // platform ceiling
const ROUNDS = 3;
export const SESSION_TTL_DAYS = 14;
export const COOKIE = 'fd_session';

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(material: ArrayBuffer, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, rounds: number): Promise<string> {
  let bits: ArrayBuffer = enc.encode(password).buffer as ArrayBuffer;
  for (let i = 0; i < rounds; i++) bits = await derive(bits, salt, iterations);
  return b64(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS, ROUNDS);
  return `pbkdf2$${ROUNDS}x${ITERATIONS}$${b64(salt.buffer)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, work, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !work) return false;
  const [rounds, iters] = work.includes('x')
    ? work.split('x').map(Number)
    : [1, Number(work)];   // tolerate the single-round format
  if (!Number.isFinite(rounds) || !Number.isFinite(iters)) return false;
  const got = await pbkdf2(password, unb64(salt), iters, rounds);
  return timingSafeEqual(got, hash);
}

/** The cookie carries the token; the database stores only its digest. */
async function digest(token: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionUser { userId: string; orgId: string; sessionId: string }

export async function createSession(
  sql: Sql, userId: string, orgId: string, ua: string | null, ip: string | null,
): Promise<{ token: string; expires: Date }> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)).buffer)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await sql`
    INSERT INTO sessions (id, user_id, org_id, expires_at, user_agent, ip)
    VALUES (${await digest(token)}, ${userId}, ${orgId}, ${expires.toISOString()},
            ${ua?.slice(0, 300) ?? null}, ${ip})`;

  return { token, expires };
}

/**
 * Resolve a cookie to a user. Runs outside any org context — the session is what tells us
 * which tenant the request belongs to — so the caller must still check the session's org
 * matches the org the hostname resolved to.
 */
export async function readSession(sql: Sql, token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  const id = await digest(token);
  const [row] = await sql<{ user_id: string; org_id: string }[]>`
    SELECT user_id, org_id FROM sessions
     WHERE id = ${id} AND expires_at > now()`;
  if (!row) return null;

  // Cheap enough, and gives "last active" without a separate write path.
  await sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${id}`;
  return { userId: row.user_id, orgId: row.org_id, sessionId: id };
}

export async function destroySession(sql: Sql, token: string | null): Promise<void> {
  if (!token) return;
  await sql`DELETE FROM sessions WHERE id = ${await digest(token)}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * HttpOnly so script cannot read it, SameSite=Lax so it rides ordinary navigation and
 * same-origin fetches but not cross-site form posts, Secure everywhere except localhost.
 */
export function sessionCookie(token: string, expires: Date, secure: boolean): string {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Expires=${expires.toUTCString()}`,
  ].filter(Boolean).join('; ');
}

export function clearCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=0`;
}
