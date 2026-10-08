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
      /**
       * Where an answer with no route of its own goes: an ask id, or 'ticket'.
       * A typed answer matches no chip, so without this a free-text question could only
       * ever lead to the one after it.
       */
      otherwise?: string;
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

/** What a shop can change about one bot without touching its questions. */
export interface FlowSettings {
  /** The launcher button's label on the shop's site. Blank = use the shop's own wording. */
  launcher?: string;
  /** The bubble that appears beside the launcher after a few seconds. */
  nudge?: string;
}

/**
 * Everything needed to write the script tag, answered by the server.
 *
 * Not derived from location.origin: in development the app is served by Vite and proxies to
 * the Worker, so a snippet built in the browser would point the shop's website at a
 * localhost that exists on one laptop.
 */
export interface Install {
  /** The origin the Worker answers on — where /w.js and /widget/config live. */
  origin: string;
  /** The tenant slug that goes in data-org. */
  org: string;
  /** Hostnames the widget and the form endpoint will accept. Empty means nothing works yet. */
  domains: string[];
}

export interface Flow {
  id: string; slug: string; name: string; steps: Step[];
  settings: FlowSettings;
  version: number; published_at: string | null; updated_at: string;
  install: Install;
  /** Whether the published copy is in KV — i.e. whether the script tag shows anything. */
  live: boolean;
}

/**
 * The one place the script tag is written.
 *
 * Both the new-bot card and the install panel render from this, so the snippet somebody
 * copies and the snippet they were shown while creating the bot cannot drift apart.
 *
 * /w.js rather than /widget/chat.js: EasyList matches "chat.js" and blocks it outright, so
 * the older path means the bubble never appears for anyone running an ad blocker.
 */
export function installSnippet(i: Install, slug: string): string {
  const origin = i.origin || 'https://your-worker-origin';
  return `<script src="${origin}/w.js" data-org="${i.org}" data-flow="${slug}" async></script>`;
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

export interface FlowSummary {
  slug: string; name: string; version: number; questions: number;
  published_at: string | null; updated_at: string; live: boolean;
  settings: FlowSettings;
}

export const flowsApi = {
  list: () => call<{ flows: FlowSummary[]; install: Install }>('/api/flows'),
  create: (name: string, slug: string) =>
    call<{ ok: true; slug: string }>('/api/flows', { method: 'POST', body: JSON.stringify({ name, slug }) }),
  pause: (slug: string) =>
    call<{ ok: true; live: false }>(`/api/flows/${slug}/pause`, { method: 'POST' }),
  get: (slug: string) => call<Flow>(`/api/flows/${slug}`),
  save: (slug: string, name: string, steps: Step[]) =>
    call<{ ok: true; version: number }>(`/api/flows/${slug}`, { method: 'PUT', body: JSON.stringify({ name, steps }) }),
  publish: (slug: string) =>
    call<{ ok: true; version: number }>(`/api/flows/${slug}/publish`, { method: 'POST' }),
  /**
   * Name and website wording. Separate from save() because that is the builder's debounced
   * autosave of the step list — sharing a body would have a settings form and a half-typed
   * question overwriting one another.
   */
  settings: (slug: string, patch: { name?: string; launcher?: string; nudge?: string }) =>
    call<{ ok: true; name: string; settings: FlowSettings; live: boolean }>(
      `/api/flows/${slug}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /**
   * The hostnames the widget is allowed to load on. Org-wide, not per bot: the same list
   * gates the website quote form, and it is where the CORS check reads from.
   */
  saveDomains: (allowed_domains: string[]) =>
    call<{ ok: true; allowed_domains: string[]; rejected: string[] }>(
      '/api/settings/widget', { method: 'PUT', body: JSON.stringify({ allowed_domains }) }),
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
