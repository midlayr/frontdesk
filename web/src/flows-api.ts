import { orgSlug } from './api';

export type Step =
  | {
      kind: 'ask';
      /** Stable across reorders, so a branch keeps pointing at the same question. */
      id?: string;
      prompt: string;
      field: string;
      chips?: string;
      skippable?: boolean;
      /** Chip label (or 'Skip') → an ask id, or 'ticket' to finish there. */
      next?: Record<string, string>;
    }
  | { kind: 'rule'; words: string; handoff: string; route: string; afterHours?: boolean }
  | { kind: 'ticket'; text: string };

/** Where an answer can lead. Absent from `next` means "the following question". */
export const FALL_THROUGH = '';
export const TO_TICKET = 'ticket';

/**
 * Give every question an id, in place, before anything can point at one.
 *
 * The client has to do this rather than leaning on the server, because a branch target is an
 * id and the save response does not hand the ids back — so the editor would be choosing
 * destinations it has no name for. The server keeps whatever ids arrive and only invents one
 * where it is missing.
 */
export function withIds(steps: Step[]): Step[] {
  const seen = new Set<string>();
  return steps.map((s) => {
    if (s.kind !== 'ask') return s;
    const id = s.id && !seen.has(s.id) ? s.id : crypto.randomUUID();
    seen.add(id);
    return { ...s, id };
  });
}

/** The answer labels that get their own destination: the quick replies, plus Skip. */
export function labelsOf(s: Extract<Step, { kind: 'ask' }>): string[] {
  const chips = (s.chips ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  return s.skippable ? [...chips, 'Skip'] : chips;
}

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
  /** Ids of questions a branch can loop back to. Computed server-side by the engine. */
  loops: string[];
}

/** Mirrors the prototype's vocabulary so the builder reads like the design. */
export const KIND: Record<Step['kind'], { label: string; color: string }> = {
  ask: { label: 'QUESTION', color: '#0B7FA8' },
  rule: { label: 'HANDOFF RULE', color: '#B4690E' },
  ticket: { label: 'CREATE TICKET', color: '#1F7A4D' },
};

export const FIELDS: Record<string, string> = {
  // job
  product: 'Product', qty: 'Quantity', size: 'Size', stock: 'Stock',
  color: 'Colour', finish: 'Finish', deadline: 'Deadline',
  // who is asking — named fields land straight on the contact and company records;
  // `contact` is the older free-text catch-all the server still has to sniff
  name: 'Name', company: 'Company', email: 'Email', phone: 'Phone',
  contact: 'Contact (email or phone)',
  notes: 'Notes',
};

/** Grouped for the picker, so the contact fields read as a set. */
export const FIELD_GROUPS: { label: string; fields: string[] }[] = [
  { label: 'Job', fields: ['product', 'qty', 'size', 'stock', 'color', 'finish', 'deadline'] },
  { label: 'Contact', fields: ['name', 'company', 'email', 'phone', 'contact'] },
  { label: 'Other', fields: ['notes'] },
];

/** Dropped in by "+ Add contact questions" — the set most shops want every time. */
export const CONTACT_DEFAULTS: { prompt: string; field: string; skippable?: boolean }[] = [
  { prompt: 'Who am I speaking with?', field: 'name' },
  { prompt: 'What company is this for?', field: 'company', skippable: true },
  { prompt: "What's the best email for the quote?", field: 'email' },
  { prompt: 'And a phone number, in case we need to check a detail?', field: 'phone', skippable: true },
];

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
