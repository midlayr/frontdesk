import { orgSlug } from './api';

export interface Sequence {
  id: string; name: string; trigger: string; channel: string; active: boolean;
  trigger_config: Record<string, unknown>; send_as: string;
  steps: number; active_count: number; held_count: number; total_count: number;
}

export interface Step {
  id: string; position: number; kind: 'email' | 'sms' | 'wait' | 'task';
  subject: string | null; body: string; attach_quote: boolean;
  branches: unknown[]; delay_hours: number;
}

export interface Preview {
  kind: string; from: string; reply_to: string; subject: string; body: string;
  footer: string; missing: string[];
  against: { ticket_no: string; company: string | null } | null;
}

/** The merge tokens a step body may use, in the order the wireframe lists them. */
export const TOKENS = [
  'first_name', 'company', 'qty', 'product', 'size', 'stock',
  'deadline', 'quote_amount', 'quote_link', 'ticket_no', 'rep_name', 'rep_phone',
] as const;

export const KINDS: { id: Step['kind']; label: string }[] = [
  { id: 'email', label: 'Email' }, { id: 'sms', label: 'SMS' },
  { id: 'wait', label: 'Wait' }, { id: 'task', label: 'Task' },
];

export const TRIGGER_LABEL: Record<string, string> = {
  lead_created: 'A lead arrives', quoted_no_reply: 'Quoted, no reply',
  reorder_due: 'Reorder due', lapsed: 'Lapsed customer',
  list: 'Uploaded list', manual: 'Manual',
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const u = localStorage.getItem('fd_user'); if (u) h['x-dev-user'] = u;
  const t = sessionStorage.getItem('fd_token'); if (t) h['x-admin-token'] = t;
  return h;
}
const url = (p: string) => `${p}${p.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url(path), { ...init, headers: headers() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status}`);
  return j as T;
}

export const campaigns = {
  list: () => call<{ sequences: Sequence[] }>('/api/sequences').then((r) => r.sequences),
  get: async (id: string) => {
    const d = await call<{ sequence: Sequence; steps: Step[] }>(`/api/sequences/${id}`);
    // EXTRACT(epoch) comes back as a numeric, so 48 arrives as "48.00000" and lands in a
    // number input looking like a precision the field does not have.
    return { ...d, steps: d.steps.map((s) => ({ ...s, delay_hours: Math.round(Number(s.delay_hours)) })) };
  },
  create: (body: { name: string; trigger: string; channel: string }) =>
    call<{ id: string }>('/api/sequences', { method: 'POST', body: JSON.stringify(body) }),
  live: (id: string, active: boolean) =>
    call<{ active: boolean }>(`/api/sequences/${id}/live`, { method: 'POST', body: JSON.stringify({ active }) }),
  addStep: (id: string) =>
    call<{ id: string }>(`/api/sequences/${id}/steps`, { method: 'POST', body: JSON.stringify({}) }),
  saveStep: (id: string, stepId: string, patch: Partial<Step> & { delay_hours?: number }) =>
    call<{ ok: true }>(`/api/sequences/${id}/steps/${stepId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteStep: (id: string, stepId: string) =>
    call<{ ok: true }>(`/api/sequences/${id}/steps/${stepId}`, { method: 'DELETE' }),
  preview: (id: string, stepId: string, leadId?: string) =>
    call<Preview>(`/api/sequences/${id}/steps/${stepId}/preview`, {
      method: 'POST', body: JSON.stringify({ leadId }),
    }),
};

export const hours = (h: number) =>
  h === 0 ? 'immediately' : h < 24 ? `${h}h later` : `day ${Math.round(h / 24) + 1}`;
