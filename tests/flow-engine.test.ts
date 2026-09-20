import { simulate, loopingAsks, resume, emptyState } from '../src/flow-engine';
import type { Step } from '../src/env';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const branching: Step[] = [
  { kind: 'ask', id: 'a1', prompt: 'What are we printing?', field: 'product',
    chips: 'Business cards, Banners, Booklets',
    next: { 'Banners': 'a4', 'Booklets': 'ticket' } },
  { kind: 'ask', id: 'a2', prompt: 'How many?', field: 'qty', chips: '100, 250' },
  { kind: 'ask', id: 'a3', prompt: 'Your email?', field: 'email' },
  { kind: 'ask', id: 'a4', prompt: 'What dimensions?', field: 'size', next: { } },
  { kind: 'rule', words: 'rush,human', handoff: 'Bringing someone in.', route: 'live' },
  { kind: 'ticket', text: 'Done.' },
];
const bot = (s: ReturnType<typeof simulate>) => s.next.turns.filter(t => t.who === 'bot').map(t => t.text);

console.log('branching');
eq('chip with no edge falls through to the next question',
   bot(simulate(branching, ['Business cards'])), ['What are we printing?', 'How many?']);
eq('chip with an edge jumps',
   bot(simulate(branching, ['Banners'])), ['What are we printing?', 'What dimensions?']);
eq('chip pointing at the ticket ends the flow',
   bot(simulate(branching, ['Booklets'])), ['What are we printing?', 'Done.']);
eq('ticket chip marks completed', simulate(branching, ['Booklets']).completed, true);
eq('free text falls through, it does not match a chip',
   bot(simulate(branching, ['some leaflets'])), ['What are we printing?', 'How many?']);
eq('after a jump, the next question is the one after the target in document order',
   bot(simulate(branching, ['Banners', '3m x 1m'])),
   ['What are we printing?', 'What dimensions?', 'Done.']);
eq('captured follows the path taken',
   simulate(branching, ['Banners', '3m x 1m']).next.captured, { product: 'Banners', size: '3m x 1m' });
eq('the rule still wins over a branch',
   bot(simulate(branching, ['rush banners'])), ['What are we printing?', 'Bringing someone in.']);
eq('rule fires on the very first reply', simulate(branching, ['human']).handedOff, true);

console.log('deleted target');
const broken: Step[] = [
  { kind: 'ask', id: 'b1', prompt: 'One?', field: 'product', chips: 'X', next: { X: 'gone' } },
  { kind: 'ask', id: 'b2', prompt: 'Two?', field: 'qty' },
  { kind: 'ticket', text: 'End.' },
];
eq('an edge to a deleted question falls through instead of dead-ending',
   bot(simulate(broken, ['X'])), ['One?', 'Two?']);

console.log('legacy flows (no ids, no next)');
const legacy: Step[] = [
  { kind: 'ask', prompt: 'P1', field: 'product', chips: 'a, b' },
  { kind: 'ask', prompt: 'P2', field: 'qty', skippable: true },
  { kind: 'rule', words: 'rush', handoff: 'H', route: 'live' },
  { kind: 'ticket', text: 'T' },
];
eq('runs in order exactly as before', bot(simulate(legacy, ['a', 'b'])), ['P1', 'P2', 'T']);
eq('Skip is not captured', simulate(legacy, ['a', 'Skip']).next.captured, { product: 'a' });
eq('positional id is stable', simulate(legacy, ['a']).next.stepId, '#1');
eq('resume() maps a persisted stepIdx onto an id',
   resume(legacy, { ...emptyState(), stepIdx: 1 } as never).stepId, '#1');
eq('resume() leaves a modern state alone',
   resume(branching, { ...emptyState(), stepId: 'a3' }).stepId, 'a3');

console.log('loops');
eq('a well-formed flow has none', [...loopingAsks(branching)], []);

const looped: Step[] = [
  { kind: 'ask', id: 'e1', prompt: 'One?', field: 'product', chips: 'Back', next: { Back: 'e1' } },
  { kind: 'ask', id: 'e2', prompt: 'Two', field: 'qty' },
  { kind: 'ticket', text: 'E' },
];
eq('a self-referential branch is reported', [...loopingAsks(looped)], ['e1']);
eq('and the engine does not hang on it', bot(simulate(looped, ['Back', 'Back'])), ['One?', 'One?', 'One?']);

const mutual: Step[] = [
  { kind: 'ask', id: 'f1', prompt: 'One?', field: 'product', chips: 'Go', next: { Go: 'f2' } },
  { kind: 'ask', id: 'f2', prompt: 'Two?', field: 'qty', chips: 'Back', next: { Back: 'f1' } },
  { kind: 'ticket', text: 'E' },
];
eq('two questions pointing at each other are reported', [...loopingAsks(mutual)].sort(), ['f1']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
