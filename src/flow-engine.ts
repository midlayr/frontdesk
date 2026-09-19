import type { Step } from './env';

/**
 * The chat flow, as pure functions.
 *
 * Both the live ChatSession DO and the builder's preview run this. If the preview had its
 * own copy of the rules it would drift, and a preview that disagrees with production is
 * worse than no preview at all.
 */

export interface Turn { who: 'visitor' | 'bot' | 'rep'; text: string; at: number }

export interface FlowState {
  stepIdx: number;
  captured: Record<string, string>;
  turns: Turn[];
  state: 'bot' | 'live' | 'done';
}

export type Ask = Extract<Step, { kind: 'ask' }>;
export type Rule = Extract<Step, { kind: 'rule' }>;
export type Ticket = Extract<Step, { kind: 'ticket' }>;

export const asksOf = (steps: Step[]): Ask[] => steps.filter((s): s is Ask => s.kind === 'ask');
const ruleOf = (steps: Step[]) => steps.find((s): s is Rule => s.kind === 'rule');
const ticketOf = (steps: Step[]) => steps.find((s): s is Ticket => s.kind === 'ticket');

export function emptyState(): FlowState {
  return { stepIdx: 0, captured: {}, turns: [], state: 'bot' };
}

/** Quick replies for the question the visitor is on; none once a rep is live or it is over. */
export function chipsFor(steps: Step[], s: FlowState): string[] {
  const a = asksOf(steps)[s.stepIdx];
  if (!a || s.state !== 'bot') return [];
  const chips = a.chips ? a.chips.split(',').map((c) => c.trim()).filter(Boolean) : [];
  return a.skippable ? [...chips, 'Skip'] : chips;
}

/** The opening question. Returns the state unchanged when there is nothing to ask. */
export function greet(steps: Step[], s: FlowState, now = Date.now()): FlowState {
  const a = asksOf(steps)[s.stepIdx];
  if (!a || s.turns.length) return s;
  return { ...s, turns: [...s.turns, { who: 'bot', text: a.prompt, at: now }] };
}

export interface Advance {
  next: FlowState;
  handedOff: boolean;   // the rule fired — a human is wanted
  completed: boolean;   // reached the ticket step
}

/** Apply one visitor message. */
export function advance(steps: Step[], s: FlowState, text: string, now = Date.now()): Advance {
  let next: FlowState = { ...s, captured: { ...s.captured }, turns: [...s.turns, { who: 'visitor', text, at: now }] };
  if (next.state !== 'bot') return { next, handedOff: false, completed: false };

  const list = asksOf(steps);
  const cur = list[next.stepIdx];
  if (cur && text !== 'Skip') next.captured[cur.field] = text;

  const rule = ruleOf(steps);
  const words = rule ? rule.words.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean) : [];
  if (rule && words.some((w) => text.toLowerCase().includes(w))) {
    next.turns = [...next.turns, { who: 'bot', text: rule.handoff, at: now }];
    next.state = 'live';
    return { next, handedOff: true, completed: false };
  }

  next.stepIdx += 1;
  const following = list[next.stepIdx];
  if (following) {
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
