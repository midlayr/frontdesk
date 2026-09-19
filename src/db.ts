// db(): one Postgres client per request, RLS-scoped to a tenant.
import postgres from 'postgres';
import type { Env } from './index';

export type Sql = ReturnType<typeof postgres>;

export function connect(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: false });
}

/** Run `fn` inside a transaction with app.org_id set so every RLS policy scopes to this tenant. */
export async function withOrg<T>(sql: Sql, orgId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** Resolve tenant from the request hostname (custom domain or <slug>.midlayr.app), KV-cached 60s. */
export async function resolveOrg(env: Env, sql: Sql, hostname: string) {
  const key = `org:host:${hostname}`;
  const cached = await env.CONFIG.get(key, 'json');
  if (cached) return cached as Org;
  const slugMatch = hostname.match(/^([a-z0-9-]+)\.midlayr\.app$/);
  const rows = slugMatch
    ? await sql`SELECT * FROM orgs WHERE slug = ${slugMatch[1]} AND status = 'active' LIMIT 1`
    : await sql`SELECT o.* FROM orgs o JOIN org_domains d ON d.org_id = o.id WHERE d.hostname = ${hostname} AND o.status = 'active' LIMIT 1`;
  const org = rows[0] as Org | undefined;
  if (org) await env.CONFIG.put(key, JSON.stringify(org), { expirationTtl: 60 });
  return org;
}

/** Resolve tenant from an inbound Twilio number (the `To` of an SMS/call). */
export async function orgBySmsNumber(sql: Sql, to: string) {
  const rows = await sql`SELECT * FROM orgs WHERE comms->>'sms_number' = ${to} OR comms->>'voice_number' = ${to} LIMIT 1`;
  return rows[0] as Org | undefined;
}

export async function nextTicket(tx: Sql, orgId: string): Promise<string> {
  const [{ n }] = await tx`UPDATE counters SET next_ticket = next_ticket + 1 WHERE org_id = ${orgId} RETURNING next_ticket - 1 AS n`;
  return `DL-${n}`;
}

export interface Org {
  id: string; slug: string; name: string; plan: string; status: string;
  brand: { app_name?: string; color?: string; logo_r2_key?: string; show_powered_by?: boolean };
  comms: { email_from?: string; sms_number?: string; voice_number?: string; messaging_service_sid?: string; a2p_campaign_sid?: string; sms_footer?: string; signature?: string };
  widget: Record<string, unknown>; hours: Record<string, unknown>;
  features: { chat?: boolean; drip?: boolean; pathfinder?: boolean; imports?: boolean };
}
