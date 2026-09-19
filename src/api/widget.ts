import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Env, Org, PublishedFlow } from '../env';
import { connect } from '../db';

/**
 * Public surface for the embedded chat widget. No session cookie — the visitor is anonymous —
 * so the tenant comes from ?org=<slug> and CORS is limited to the domains that tenant listed.
 */
export const widget = new Hono<{ Bindings: Env }>();

function allowedOrigin(org: Org, origin: string | undefined): string | null {
  const domains = (org.widget as { allowed_domains?: unknown }).allowed_domains;
  if (!origin) return null;
  if (!Array.isArray(domains) || domains.length === 0) return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  for (const d of domains) {
    if (typeof d !== 'string') continue;
    if (d === '*') return origin;
    if (host === d || host.endsWith(`.${d}`)) return origin;
  }
  return null;
}

async function orgBySlug(env: Env, slug: string) {
  const sql = connect(env);
  try {
    const [org] = await sql<Org[]>`
      SELECT id, slug, name, brand, comms, widget, features
        FROM orgs WHERE slug = ${slug} AND status = 'active'`;
    return org ?? null;
  } finally {
    await sql.end();
  }
}

widget.get('/config', async (c) => {
  const slug = c.req.query('org');
  const flowSlug = c.req.query('flow') || 'quote-intake';
  if (!slug) return c.json({ error: 'org required' }, 400);

  const org = await orgBySlug(c.env, slug);
  if (!org) return c.json({ error: 'unknown tenant' }, 404);
  if (org.features.chat === false) return c.json({ error: 'chat not enabled' }, 403);

  const origin = allowedOrigin(org, c.req.header('origin'));
  if (origin) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
  }

  const flow = await c.env.CONFIG.get<PublishedFlow>(`flow:${org.id}:${flowSlug}`, 'json');
  const brand = org.brand as Record<string, unknown>;

  return c.json({
    orgId: org.id,
    orgName: org.name,
    flowPublished: !!flow,
    brand: {
      color: brand.color ?? '#0B7FA8',
      ink: brand.ink ?? '#14161A',
      paper: brand.paper ?? '#FBFAF8',
      app_name_public: brand.app_name_public ?? org.name,
      // The bot's display name, kept separate from the legal/org name.
      bot_name: brand.bot_name ?? String(org.name).split(/\s+/)[0],
      accent_tint: brand.accent_tint ?? null,
      show_powered_by: brand.show_powered_by ?? true,
      logo_url: brand.logo_r2_key ? `/widget/logo?org=${encodeURIComponent(org.slug)}` : null,
      mark_url: brand.mark_r2_key ? `/widget/logo?org=${encodeURIComponent(org.slug)}&kind=mark` : null,
    },
    widget: org.widget,
  });
});

widget.options('/config', (c) => c.body(null, 204));

/**
 * The tenant's logo, straight out of R2.
 *
 * Public by design — it appears on the widget on the tenant's own marketing site — but the
 * key is never taken from the query string: it is read from the org row, so this cannot be
 * turned into a reader for arbitrary objects in the bucket.
 */
widget.get('/logo', async (c) => {
  const slug = c.req.query('org');
  if (!slug) return c.text('org required', 400);
  const org = await orgBySlug(c.env, slug);
  if (!org) return c.text('unknown tenant', 404);

  // ?kind=mark gives the square mark (widget avatar, favicon); default is the wordmark.
  const brand = org.brand as { logo_r2_key?: unknown; mark_r2_key?: unknown };
  const key = c.req.query('kind') === 'mark' ? brand.mark_r2_key : brand.logo_r2_key;
  if (typeof key !== 'string' || !key.startsWith(`org/${org.id}/`)) return c.text('no logo', 404);

  const obj = await c.env.FILES.get(key);
  if (!obj) return c.text('no logo', 404);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/png',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
});

/** Upgrade to the visitor's ChatSession DO. One object per session id. */
widget.get('/session', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);

  const slug = c.req.query('org');
  if (!slug) return c.text('org required', 400);
  const org = await orgBySlug(c.env, slug);
  if (!org) return c.text('unknown tenant', 404);
  if (org.features.chat === false) return c.text('chat not enabled', 403);

  const sid = c.req.query('sid') || ulid();
  const id = c.env.CHAT_SESSION.idFromName(sid);

  // The DO is addressed by session id but initialised from the org id we just resolved,
  // so a visitor cannot open a session against a tenant by guessing an internal id.
  const url = new URL('https://do/');
  url.searchParams.set('org', org.id);
  url.searchParams.set('flow', c.req.query('flow') || 'quote-intake');
  url.searchParams.set('role', 'visitor');
  url.searchParams.set('sid', sid);
  for (const k of ['ref', 'page', 'ua'] as const) {
    const v = c.req.query(k);
    if (v) url.searchParams.set(k, v);
  }

  return c.env.CHAT_SESSION.get(id).fetch(url.toString(), c.req.raw);
});
