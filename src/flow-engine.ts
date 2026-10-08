import type { Step } from './env';

/**
 * The chat flow, as pure functions.
 *
 * Both the live ChatSession DO and the builder's preview run this. If the preview had its
 * own copy of the rules it would drift, and a preview that disagrees with production is
 * worse than no preview at all.
 *
 * Position used to be identity: the state carried an index into the asks and the next
 * question was always the following one. Branching makes that untenable — a quick reply can
 * jump anywhere — so the state carries an ask *id* instead, and `next` on a step maps an
 * answer to its destination. Flows written before that have neither, and still run: a
 * missing id resolves by position, and an answer with no entry in `next` falls through to
 * the following question, which is exactly the old behaviour.
 */

export interface Turn { who: 'visitor' | 'bot' | 'rep'; text: string; at: number }

export interface FlowState {
  /** null before the first question has been chosen. */
  stepId: string | null;
  /**
   * One entry per question, keyed by ask id. The record of what was actually said.
   *
   * `captured` is derived from this and is keyed by FIELD, which is lossy on purpose —
   * downstream wants one email, one quantity. It cannot be the store, because a field is a
   * destination, not an identity: several questions legitimately pour into `notes`, and
   * keying the store by field threw all but the last of them away.
   */
  answers: Record<string, string>;
  /** Derived from `answers`. Field → value, for the ticket, the contact and the search index. */
  captured: Record<string, string>;
  turns: Turn[];
  state: 'bot' | 'live' | 'done';
}

export type Ask = Extract<Step, { kind: 'ask' }>;
export type Rule = Extract<Step, { kind: 'rule' }>;
export type Ticket = Extract<Step, { kind: 'ticket' }>;

/** Reserved destination: end the flow here rather than at the last question. */
export const TO_TICKET = 'ticket';

export const asksOf = (steps: Step[]): Ask[] => steps.filter((s): s is Ask => s.kind === 'ask');
const ruleOf = (steps: Step[]) => steps.find((s): s is Rule => s.kind === 'rule');
const ticketOf = (steps: Step[]) => steps.find((s): s is Ticket => s.kind === 'ticket');

/** The id to store for an ask. `#n` is the legacy positional form, for flows with no ids. */
export function idOf(steps: Step[], a: Ask): string {
  return a.id ?? `#${asksOf(steps).indexOf(a)}`;
}

export function askById(steps: Step[], id: string | null | undefined): Ask | null {
  if (!id) return null;
  const list = asksOf(steps);
  const hit = list.find((a) => a.id === id);
  if (hit) return hit;
  const legacy = /^#(\d+)$/.exec(id);
  return legacy ? list[Number(legacy[1])] ?? null : null;
}

/** The question the visitor is on. A null stepId means the flow has not started. */
function currentAsk(steps: Step[], s: FlowState): Ask | null {
  return s.stepId ? askById(steps, s.stepId) : asksOf(steps)[0] ?? null;
}

/** The question after this one in document order — where an unlabelled answer goes. */
export function fallThrough(steps: Step[], cur: Ask): Ask | null {
  const list = asksOf(steps);
  return list[list.indexOf(cur) + 1] ?? null;
}

/**
 * Where an answer leads.
 *
 * Returns the next question, or null to finish. An explicit edge wins; a chip pointing at a
 * question that has since been deleted falls through rather than dead-ending, because a
 * half-edited flow should still get the visitor to a ticket.
 */
export function nextAfter(steps: Step[], cur: Ask | null, answer: string): Ask | null {
  if (!cur) return null;
  const edge = cur.next?.[answer] ?? cur.otherwise;
  if (edge === TO_TICKET) return null;
  if (edge) {
    const target = askById(steps, edge);
    if (target) return target;
  }
  // No edge, or one pointing at a question since deleted: the following question. A
  // half-edited flow should still carry the visitor to a ticket.
  return fallThrough(steps, cur);
}

export function emptyState(): FlowState {
  return { stepId: null, answers: {}, captured: {}, turns: [], state: 'bot' };
}

/**
 * Fold the per-question answers down onto their fields.
 *
 * A field with one question behind it is written exactly as before, so `email`, `qty` and
 * every other single-answer field are byte-identical to what they were — nothing downstream
 * sees a change.
 *
 * A field with several questions behind it keeps all of them, each labelled with the
 * question that produced it, because "Spot UV on the logo" is not worth much on a job
 * ticket without "Any special finishing?" in front of it.
 *
 * Walked in step order rather than in answer order, so the ticket reads in the order the
 * flow asks — stable no matter which branch the visitor took, or how often they looped back.
 */
export function composeCaptured(steps: Step[], answers: Record<string, string>): Record<string, string> {
  const byField = new Map<string, { prompt: string; text: string }[]>();
  for (const a of asksOf(steps)) {
    const text = answers[idOf(steps, a)];
    if (typeof text !== 'string' || !text) continue;
    const list = byField.get(a.field) ?? [];
    list.push({ prompt: a.prompt, text });
    byField.set(a.field, list);
  }

  const out: Record<string, string> = {};
  for (const [field, list] of byField) {
    out[field] = list.length === 1
      ? list[0].text
      : list.map((e) => `${e.prompt.replace(/\s*[?:]\s*$/, '')} — ${e.text}`).join('\n');
  }
  return out;
}

/**
 * Bring a persisted state up to date.
 *
 * Sessions saved before branching carry `stepIdx`, an index into the asks. Translating it
 * here means a conversation that was mid-answer when this shipped carries on from the same
 * question instead of silently restarting.
 */
export function resume(steps: Step[], s: FlowState & { stepIdx?: number }): FlowState {
  let out = s;

  // Sessions saved before answers were kept per question have only the field map. Attribute
  // each value to the first question that asks for that field: it is the best reading
  // available, and without it the next answer would recompose `captured` from an empty
  // record and wipe everything the visitor had already said.
  if (!out.answers) {
    const answers: Record<string, string> = {};
    for (const a of asksOf(steps)) {
      const v = out.captured?.[a.field];
      const id = idOf(steps, a);
      if (typeof v === 'string' && v && !Object.values(answers).includes(v)) answers[id] = v;
    }
    out = { ...out, answers };
  }

  if (out.stepId || typeof out.stepIdx !== 'number') return out;
  const a = asksOf(steps)[out.stepIdx];
  return { ...out, stepId: a ? idOf(steps, a) : null };
}

/** Quick replies for the question the visitor is on; none once a rep is live or it is over. */
export function chipsFor(steps: Step[], s: FlowState): string[] {
  const a = currentAsk(steps, s);
  if (!a || s.state !== 'bot') return [];
  const chips = a.chips ? a.chips.split(',').map((c) => c.trim()).filter(Boolean) : [];
  return a.skippable ? [...chips, 'Skip'] : chips;
}

/** Every answer label that has its own edge slot in the builder. */
export function labelsOf(a: Ask): string[] {
  const chips = (a.chips ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  return a.skippable ? [...chips, 'Skip'] : chips;
}

/** The opening question. Returns the state unchanged when there is nothing to ask. */
export function greet(steps: Step[], s: FlowState, now = Date.now()): FlowState {
  const a = currentAsk(steps, s);
  if (!a || s.turns.length) return s;
  return { ...s, stepId: idOf(steps, a), turns: [...s.turns, { who: 'bot', text: a.prompt, at: now }] };
}

export interface Advance {
  next: FlowState;
  handedOff: boolean;   // the rule fired — a human is wanted
  completed: boolean;   // reached the ticket step
}

/** Apply one visitor message. */
export function advance(steps: Step[], s: FlowState, text: string, now = Date.now()): Advance {
  let next: FlowState = { ...s, answers: { ...s.answers }, captured: { ...s.captured },
                          turns: [...s.turns, { who: 'visitor', text, at: now }] };
  if (next.state !== 'bot') return { next, handedOff: false, completed: false };

  const cur = currentAsk(steps, next);
  if (cur && text !== 'Skip') {
    // Keyed by the question, not by the field. Answering the same question twice — which a
    // branch looping back makes possible — still replaces, because it is the same question.
    next.answers[idOf(steps, cur)] = text;
    next.captured = composeCaptured(steps, next.answers);
  }

  const rule = ruleOf(steps);
  const words = rule ? rule.words.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean) : [];
  if (rule && words.some((w) => text.toLowerCase().includes(w))) {
    next.turns = [...next.turns, { who: 'bot', text: rule.handoff, at: now }];
    next.state = 'live';
    return { next, handedOff: true, completed: false };
  }

  const following = nextAfter(steps, cur, text);
  if (following) {
    next.stepId = idOf(steps, following);
    next.turns = [...next.turns, { who: 'bot', text: following.prompt, at: now }];
    return { next, handedOff: false, completed: false };
  }

  const t = ticketOf(steps);
  next.turns = [...next.turns, { who: 'bot', text: t?.text ?? 'Thanks — your request is in.', at: now }];
  next.state = 'done';
  return { next, handedOff: false, completed: true };
}

/** Replay a whole conversation from scratch — what the builder's preview needs. */
export function simulate(steps: Step[], said: string[]): Advance & { chips: string[] } {
  let s = greet(steps, emptyState());
  let handedOff = false;
  let completed = false;
  for (const text of said) {
    const r = advance(steps, s, text);
    s = r.next;
    handedOff = handedOff || r.handedOff;
    completed = completed || r.completed;
  }
  return { next: s, handedOff, completed, chips: chipsFor(steps, s) };
}

/** Every question an answer can lead to from here, fall-through included. */
export function edgesFrom(steps: Step[], a: Ask): { label: string | null; to: Ask | null }[] {
  const labels = labelsOf(a);
  const out: { label: string | null; to: Ask | null }[] = [];
  // Free text always exists as a path: no chip matches it, so it takes the question's own
  // 'otherwise' if it has one, and the following question if it does not. The only case
  // where it cannot happen is a question whose every label is pinned somewhere else AND
  // which the visitor can only answer by tapping — which the widget does not enforce.
  out.push({ label: null, to: nextAfter(steps, a, '\u0000no chip matches this\u0000') });
  for (const l of labels) out.push({ label: l, to: nextAfter(steps, a, l) });
  return out;
}

/**
 * Branches that loop back on themselves.
 *
 * There is deliberately no unreachable-question check to go with this: free text matches no
 * chip, so every question always falls through to the one after it, which makes every
 * question reachable by construction. A warning that cannot fire is worse than none.
 *
 * A loop does not hang anything — the visitor answers one question per message either way —
 * but it means someone can be asked the same thing forever, so the map flags it.
 */
export function loopingAsks(steps: Step[]): Set<string> {
  const list = asksOf(steps);
  const loops = new Set<string>();
  const done = new Set<string>();
  if (!list.length) return loops;

  const walk = (a: Ask, path: Set<string>) => {
    const id = idOf(steps, a);
    if (path.has(id)) { loops.add(id); return; }
    if (done.has(id)) return;
    done.add(id);
    const onward = new Set(path).add(id);
    for (const e of edgesFrom(steps, a)) if (e.to) walk(e.to, onward);
  };
  walk(list[0], new Set());

  return loops;
}
