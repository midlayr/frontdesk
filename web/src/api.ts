/** Everything the app knows about the Worker. One place so auth stays consistent. */

export interface Lead {
  id: string; ticket_no: string; channel: string; status: string; rush: boolean;
  deadline_at: string | null; assignee_id: string | null;
  product: string | null; qty: number | null; size: string | null;
  stock: string | null; color: string | null; finish: string | null;
  confidence: Record<string, number>; missing_fields: string[];
  intent_score: number | null; first_reply_at: string | null; created_at: string;
  updated_at: string; last_in_at: string | null;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null;
  chat_sid: string | null;
}

export interface Message {
  id: string; channel: string; direction: 'in' | 'out';
  author: string; body: string | null; sent_at: string;
}

export interface Org {
  id: string; slug: string; name: string;
  brand: Record<string, string | boolean | null>;
  features: Record<string, boolean>;
}

const params = new URLSearchParams(location.search);
export const orgSlug = params.get('org') ?? 'dumont';
export const userId = params.get('user') ?? localStorage.getItem('fd_user') ?? '';
if (userId) localStorage.setItem('fd_user', userId);

export function setToken(t: string) { sessionStorage.setItem('fd_token', t); }
export function getToken() { return sessionStorage.getItem('fd_token') ?? ''; }

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'x-dev-user': userId };
  const t = getToken();
  if (t) h['x-admin-token'] = t;
  return h;
}

/** ?org= is only honoured on localhost; in production the hostname resolves the tenant. */
function url(path: string) {
  return `${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(url(path), { headers: headers() });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  org: () => get<Org>('/api/org'),
  leads: (q?: { status?: string; q?: string }) => {
    const s = new URLSearchParams();
    if (q?.status) s.set('status', q.status);
    if (q?.q) s.set('q', q.q);
    return get<{ leads: Lead[] }>(`/api/leads${s.toString() ? `?${s}` : ''}`);
  },
  lead: (id: string) => get<{ lead: Lead; messages: Message[]; activity: unknown[] }>(`/api/leads/${id}`),

  reply: async (id: string, body: string) => {
    const r = await fetch(url(`/api/leads/${id}/reply`), {
      method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },

  takeover: async (id: string) => {
    const r = await fetch(url(`/api/leads/${id}/takeover`), { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },

  /** Sockets carry a one-minute ticket; the admin token must never appear in a URL. */
  socket: async (path: string) => {
    const u = new URL(path, location.origin);
    u.protocol = u.protocol.replace('http', 'ws');
    u.searchParams.set('org', orgSlug);
    try {
      const r = await fetch(url('/api/ws-ticket'), { method: 'POST', headers: headers() });
      if (r.ok) u.searchParams.set('ticket', (await r.json()).ticket);
      else u.searchParams.set('user', userId);
    } catch { u.searchParams.set('user', userId); }
    return new WebSocket(u.toString());
  },
};

/** BRAND.md: derive deep/tint from the tenant accent rather than storing three colours. */
function shade(hex: string, amt: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt))));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function applyBrand(org: Org) {
  const b = org.brand as Record<string, string>;
  const root = document.documentElement.style;
  if (b.color) {
    root.setProperty('--accent', b.color);
    root.setProperty('--accent-deep', shade(b.color, -0.2));
    root.setProperty('--accent-tint', shade(b.color, 0.9));
    root.setProperty('--accent-tint-fg', shade(b.color, -0.2));
  }
  document.title = b.app_name || `${org.name} · Front Desk`;
}
