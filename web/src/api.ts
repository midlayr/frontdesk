/** Everything the app knows about the Worker. One place so auth stays consistent. */

export interface Lead {
  id: string; ticket_no: string; channel: string; status: string; rush: boolean;
  deadline_at: string | null; assignee_id: string | null;
  product: string | null; qty: number | null; size: string | null;
  stock: string | null; color: string | null; finish: string | null;
  confidence: Record<string, number>; missing_fields: string[];
  intent_score: number | null; first_reply_at: string | null; created_at: string;
  updated_at: string; last_in_at: string | null; archived_at?: string | null;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null;
  company_name?: string | null;
  chat_sid: string | null;
}

export interface Message {
  id: string; channel: string; direction: 'in' | 'out';
  author: string; body: string | null; sent_at: string;
  has_audio?: boolean; transcript_status?: 'pending' | 'done' | 'failed' | null;
}

export interface OrgUser { id: string; name: string; email: string; role: string }

/**
 * The pipeline, in the order a job moves through it.
 *
 * One list drives the ticket's status picker and the queue's views, so a stage cannot be
 * offered in one place and missing from the other. 'live' and 'closed' are deliberately
 * absent: 'live' is set by the chat session, not chosen by a rep, and 'closed' has no
 * meaning the shop uses yet.
 */
export const PIPELINE = ['new', 'needs_info', 'replied', 'quoted', 'won', 'lost', 'spam'] as const;

export const STATUS_LABEL: Record<string, string> = {
  new: 'New', needs_info: 'Working', replied: 'Replied', quoted: 'Quoted',
  won: 'Won', lost: 'Lost', spam: 'Spam', closed: 'Closed', live: 'Live',
};

export const STATUS_DOT: Record<string, string> = {
  new: 'var(--accent)', needs_info: 'var(--warn)', replied: 'var(--ink-3)',
  quoted: 'var(--accent-deep)', won: 'var(--ok)', lost: 'var(--ink-3)',
  spam: 'var(--ink-3)', closed: 'var(--ink-3)', live: 'var(--ok-bright)',
};

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

/**
 * The session cookie does the work and rides along automatically. The dev-user and operator
 * headers stay only as an escape hatch for automation and local work, and are simply absent
 * for a signed-in person.
 */
function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  if (userId) h['x-dev-user'] = userId;
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

export interface Me { user: { id: string; name: string; email: string; role: string } | null; org: { id: string; slug: string; name: string } }

export const api = {
  me: () => get<Me>('/api/me'),

  login: async (email: string, password: string) => {
    const r = await fetch(url('/api/session'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `${r.status}`);
    return r.json();
  },

  logout: () => fetch(url('/api/session'), { method: 'DELETE', headers: headers() }),

  org: () => get<Org>('/api/org'),
  leads: (q?: { status?: string; q?: string; archived?: boolean }) => {
    const s = new URLSearchParams();
    if (q?.status) s.set('status', q.status);
    if (q?.q) s.set('q', q.q);
    if (q?.archived) s.set('archived', '1');
    return get<{ leads: Lead[] }>(`/api/leads${s.toString() ? `?${s}` : ''}`);
  },

  archive: async (id: string, undo = false) => {
    const r = await fetch(url(`/api/leads/${id}/archive${undo ? '?undo=1' : ''}`), { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },

  remove: async (id: string) => {
    const r = await fetch(url(`/api/leads/${id}`), { method: 'DELETE', headers: headers() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
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

  users: () => get<{ users: OrgUser[] }>('/api/users').then((r) => r.users),

  patch: async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(url(`/api/leads/${id}`), {
      method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },

  takeover: async (id: string) => {
    const r = await fetch(url(`/api/leads/${id}/takeover`), { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  },

  /** A 15-minute ticket for <audio>, which cannot send an auth header. */
  mediaTicket: async (): Promise<string> => {
    const r = await fetch(url('/api/ws-ticket?for=media'), { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()).ticket as string;
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
