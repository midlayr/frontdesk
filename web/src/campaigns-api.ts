import { orgSlug } from './api';

export interface Sequence {
  id: string; name: string; trigger: string; channel: string; active: boolean;
  trigger_config: Record<string, unknown>; send_as: string;
  steps: number; active_count: number; held_count: number; total_count: number;
}

export interface Step {
  id: string; position: number; kind: 'email' | 'sms' | 'wait' | 'task';
  subject: string | null; body: string; attach_quote: boolean;
  branches: Branch[]; delay_hours: number;
}

export interface Preview {
  kind: string; from: string; reply_to: string; subject: string; body: string;
  footer: string; missing: string[];
  against: { ticket_no: string; company: string | null } | null;
}

/** The merge tokens a step body may use, in the order the wireframe lists them. */
export interface Enrollment {
  id: string; state: string; held_reason: string | null; next_send_at: string | null;
  next_step: number; last_sent_at: string | null;
  lead_id: string; ticket_no: string; lead_status: string; who: string | null; steps: number;
}

export const STATE_LABEL: Record<string, string> = {
  active: 'Active', held: 'Held', paused: 'Paused', replied: 'Replied',
  completed: 'Done', opted_out: 'Opted out', removed: 'Removed',
};

export const STATE_COLOR: Record<string, string> = {
  active: 'var(--ok)', held: 'var(--warn)', paused: 'var(--ink-3)',
  replied: 'var(--accent)', completed: 'var(--ink-3)',
  opted_out: 'var(--danger)', removed: 'var(--ink-3)',
};

export const TOKENS = [
  'first_name', 'company', 'qty', 'product', 'size', 'stock',
  'deadline', 'quote_amount', 'quote_link', 'ticket_no', 'rep_name', 'rep_phone',
] as const;

export interface Branch {
  if: string; value?: number; then: string;
  config?: { subject?: string; step?: number; user_id?: string; text?: string; tag?: string };
}

/** Mirrors CONDITIONS / ACTIONS in src/lib/drip.ts — the engine is the authority. */
export const CONDITIONS: { id: string; label: string; needs?: 'number' }[] = [
  { id: 'replied', label: 'Replied' },
  { id: 'opened_no_reply', label: 'Opened, no reply' },
  { id: 'not_opened', label: 'Not opened' },
  { id: 'clicked', label: 'Clicked a link' },
  { id: 'bounced', label: 'Bounced' },
  { id: 'sms_delivered', label: 'SMS delivered' },
  { id: 'health_below', label: 'Health below', needs: 'number' },
];

export const ACTIONS: { id: string; label: string; needs?: 'subject' | 'step' | 'user' | 'text' | 'tag' }[] = [
  { id: 'continue', label: 'Continue' },
  { id: 'stop', label: 'Stop sequence' },
  { id: 'resend', label: 'Resend, new subject', needs: 'subject' },
  { id: 'skip_to', label: 'Skip to step', needs: 'step' },
  { id: 'switch_sms', label: 'Send as SMS instead' },
  { id: 'assign', label: 'Assign to', needs: 'user' },
  { id: 'task', label: 'Create a task', needs: 'text' },
  { id: 'tag', label: 'Tag the company', needs: 'tag' },
];

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
  addStep: async (id: string) => {
    const r = await call<{ step: Step }>(`/api/sequences/${id}/steps`, { method: 'POST', body: JSON.stringify({}) });
    return { ...r, step: { ...r.step, delay_hours: Math.round(Number(r.step.delay_hours)) } };
  },
  saveStep: (id: string, stepId: string, patch: Partial<Step> & { delay_hours?: number; branches?: Branch[] }) =>
    call<{ ok: true }>(`/api/sequences/${id}/steps/${stepId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteStep: (id: string, stepId: string) =>
    call<{ ok: true }>(`/api/sequences/${id}/steps/${stepId}`, { method: 'DELETE' }),
  preview: (id: string, stepId: string, leadId?: string) =>
    call<Preview>(`/api/sequences/${id}/steps/${stepId}/preview`, {
      method: 'POST', body: JSON.stringify({ leadId }),
    }),
};

export interface StatRow {
  step_id: string | null; span: string; enrolled: number; sent: number; opened: number;
  clicked: number; replied: number; won: number; revenue: string; read: string | null;
  computed_at: string;
}

export const stats = {
  get: (id: string, span: string) =>
    call<{ span: string; stats: StatRow[]; steps: { id: string; position: number; kind: string; subject: string | null }[] }>(
      `/api/sequences/${id}/stats?span=${span}`),
};

export const enrollments = {
  list: (id: string, state?: string) =>
    call<{ enrollments: Enrollment[] }>(
      `/api/sequences/${id}/enrollments${state ? `?state=${state}` : ''}`).then((r) => r.enrollments),
  bulk: (id: string, ids: string[], state: 'active' | 'paused' | 'removed') =>
    call<{ changed: number }>(`/api/sequences/${id}/enrollments`, {
      method: 'PATCH', body: JSON.stringify({ ids, state }),
    }),
};

/** "in 2 days", "overdue", "—". A drip's next touch is the column reps actually scan. */
export function when(iso: string | null): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < -60_000) return 'overdue';
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return 'within the hour';
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)} days`;
}

export const hours = (h: number) =>
  h === 0 ? 'immediately' : h < 24 ? `${h}h later` : `day ${Math.round(h / 24) + 1}`;
