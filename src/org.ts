import type { Env, Org } from './env';
import type { Sql } from './db';

const CACHE_TTL = 60;

const SELECT_ORG = 'id, slug, name, brand, comms, widget, features';

// orgs and org_domains sit outside RLS on purpose: resolution happens before an org context exists.

function isDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}

async function cached(env: Env, key: string, load: () => Promise<Org | null>): Promise<Org | null> {
  const hit = await env.CONFIG.get(`org:${key}`, 'json');
  if (hit) return hit as Org;
  const org = await load();
  if (org) await env.CONFIG.put(`org:${key}`, JSON.stringify(org), { expirationTtl: CACHE_TTL });
  return org;
}

async function bySlug(sql: Sql, slug: string): Promise<Org | null> {
  const rows = await sql.unsafe<Org[]>(`SELECT ${SELECT_ORG} FROM orgs WHERE slug = $1 AND status = 'active'`, [slug]);
  return rows[0] ?? null;
}

/**
 * hostname → org.
 *
 * 1. an exact custom hostname in org_domains (Cloudflare for SaaS)
 * 2. <slug>.PLATFORM_DOMAIN
 * 3. dev only: ?org=<slug> when the request is to localhost, since wrangler dev has no
 *    tenant hostname to resolve. Gated on the hostname so it cannot be used in production.
 */
export async function resolveOrg(env: Env, sql: Sql, url: URL): Promise<Org | null> {
  const hostname = url.hostname.toLowerCase();

  if (isDevHost(hostname)) {
    const slug = url.searchParams.get('org');
    return slug ? bySlug(sql, slug) : null;
  }

  return cached(env, hostname, async () => {
    const viaDomain = await sql.unsafe<Org[]>(
      `SELECT ${SELECT_ORG.split(', ').map((c) => 'o.' + c).join(', ')}
         FROM org_domains d JOIN orgs o ON o.id = d.org_id
        WHERE d.hostname = $1 AND d.verified_at IS NOT NULL AND o.status = 'active'`,
      [hostname],
    );
    if (viaDomain[0]) return viaDomain[0];

    const suffix = `.${env.PLATFORM_DOMAIN}`;
    if (hostname.endsWith(suffix)) return bySlug(sql, hostname.slice(0, -suffix.length));
    return null;
  });
}

/**
 * Inbound webhooks arrive at a shared platform hostname, so the tenant comes from the
 * number the customer texted, not from the URL.
 */
export async function resolveOrgByPhone(env: Env, sql: Sql, to: string): Promise<Org | null> {
  return cached(env, `sms:${to}`, async () => {
    const rows = await sql.unsafe<Org[]>(
      `SELECT ${SELECT_ORG} FROM orgs
        WHERE comms->>'sms_number' = $1 AND status = 'active'`,
      [to],
    );
    return rows[0] ?? null;
  });
}

/**
 * Drop every cached copy of an org after its row changes.
 *
 * resolveOrg caches under one key per hostname, plus <slug>.PLATFORM_DOMAIN, and
 * resolveOrgByPhone caches under the SMS number. Clearing only one of them means a settings
 * save appears to do nothing for up to a minute — which reads as a broken Save button.
 */
export async function invalidateOrg(env: Env, sql: Sql, org: Org): Promise<void> {
  const keys = [
    `org:${org.slug}.${env.PLATFORM_DOMAIN}`.toLowerCase(),
    `org:sms:${(org.comms.sms_number ?? '').trim()}`,
  ];

  const hosts = await sql.unsafe<{ hostname: string }[]>(
    'SELECT hostname FROM org_domains WHERE org_id = $1', [org.id]);
  for (const h of hosts) keys.push(`org:${h.hostname.toLowerCase()}`);

  await Promise.all(keys.map((k) => env.CONFIG.delete(k)));
}

/** Ticket prefix is tenant data, never a constant in code. */
export function ticketPrefix(org: Org): string {
  const fromBrand = (org.brand as { ticket_prefix?: unknown }).ticket_prefix;
  if (typeof fromBrand === 'string' && fromBrand.length) return fromBrand;
  return org.slug.slice(0, 2).toUpperCase();
}
