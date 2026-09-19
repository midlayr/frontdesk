import { orgSlug } from './api';

export type Step =
  | { kind: 'ask'; prompt: string; field: string; chips?: string; skippable?: boolean }
  | { kind: 'rule'; words: string; handoff: string; route: string; afterHours?: boolean }
  | { kind: 'ticket'; text: string };

export interface Flow {
  id: string; slug: string; name: string; steps: Step[];
  version: number; published_at: string | null; updated_at: string;
}

export interface SimResult {
  turns: { who: 'visitor' | 'bot' | 'rep'; text: string; at: number }[];
  chips: string[];
  captured: Record<string, string>;
  state: 'bot' | 'live' | 'done';
  handedOff: boolean;
  completed: boolean;
}

/** Mirrors the prototype's vocabulary so the builder reads like the design. */
export const KIND: Record<Step['kind'], { label: string; color: string }> = {
  ask: { label: 'QUESTION', color: '#0B7FA8' },
  rule: { label: 'HANDOFF RULE', color: '#B4690E' },
  ticket: { label: 'CREATE TICKET', color: '#1F7A4D' },
};

export const FIELDS: Record<string, string> = {
  product: 'Product', qty: 'Quantity', size: 'Size', stock: 'Stock',
  deadline: 'Deadline', contact: 'Contact', notes: 'Notes',
};

export const ROUTES: Record<string, string> = {
  live: 'Bring in a rep now',
  next: 'Carry on with the next question',
  ticket: 'Create the ticket and stop',
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', 'x-dev-user': localStorage.getItem('fd_user') ?? '' };
  const t = sessionStorage.getItem('fd_token');
  if (t) h['x-admin-token'] = t;
  return h;
}

const url = (p: string) => `${p}${p.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url(path), { ...init, headers: headers() });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const flowsApi = {
  get: (slug: string) => call<Flow>(`/api/flows/${slug}`),
  save: (slug: string, name: string, steps: Step[]) =>
    call<{ ok: true; version: number }>(`/api/flows/${slug}`, { method: 'PUT', body: JSON.stringify({ name, steps }) }),
  publish: (slug: string) =>
    call<{ ok: true; version: number }>(`/api/flows/${slug}/publish`, { method: 'POST' }),
  simulate: (slug: string, steps: Step[], said: string[]) =>
    call<SimResult>(`/api/flows/${slug}/simulate`, { method: 'POST', body: JSON.stringify({ steps, said }) }),
};

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
