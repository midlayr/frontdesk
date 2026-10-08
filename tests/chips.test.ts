/*
 * flows-api reads location/localStorage at module scope for the dev org switch, so the
 * browser globals it expects are stubbed before it loads. Only withChips is under test and
 * it touches none of them.
 */
const g = globalThis as Record<string, unknown>;
g.location = { search: '?org=dumont', origin: 'http://localhost' };
const store = new Map<string, string>();
const shim = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
g.localStorage = shim;
g.sessionStorage = shim;

const { withChips } = await import('../web/src/flows-api');
type Step = import('../web/src/flows-api').Step;

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const base = {
  kind: 'ask', id: 'q0', prompt: 'What are you looking to print?', field: 'product',
  chips: 'Business Cards, Window & Wall Grpahics, Packaging',
  next: { 'Window & Wall Grpahics': 'ask_windows', 'Packaging': 'ask_pack' },
} as Extract<Step, { kind: 'ask' }>;

console.log('renaming a chip keeps its branch');
{
  const r = withChips(base, 'Business Cards, Window & Wall Graphics, Packaging') as typeof base;
  eq('the label is corrected', r.chips, 'Business Cards, Window & Wall Graphics, Packaging');
  // The whole point: the route moves to the new text, so the answer still finds it.
  eq('the branch moved with it', r.next, { 'Packaging': 'ask_pack', 'Window & Wall Graphics': 'ask_windows' });
  eq('no orphan left behind', Object.keys(r.next!).includes('Window & Wall Grpahics'), false);
}

console.log('typing it one character at a time');
{
  // How a person actually fixes a typo: each keystroke is its own one-for-one rename.
  let step = base;
  for (const chips of [
    'Business Cards, Window & Wall Grpahic, Packaging',
    'Business Cards, Window & Wall Grpahi, Packaging',
    'Business Cards, Window & Wall Grpah, Packaging',
    'Business Cards, Window & Wall Graph, Packaging',
    'Business Cards, Window & Wall Graphi, Packaging',
    'Business Cards, Window & Wall Graphic, Packaging',
    'Business Cards, Window & Wall Graphics, Packaging',
  ]) step = withChips(step, chips) as typeof base;
  eq('the route survives every keystroke', step.next!['Window & Wall Graphics'], 'ask_windows');
  eq('and nothing was duplicated', Object.keys(step.next!).sort(), ['Packaging', 'Window & Wall Graphics']);
}

console.log('changes that are not a rename');
{
  const added = withChips(base, 'Business Cards, Window & Wall Grpahics, Packaging, Banners') as typeof base;
  eq('adding a chip touches no route', added.next, base.next);

  const removed = withChips(base, 'Business Cards, Packaging') as typeof base;
  // A deletion is a deletion: the route is left for the engine to fall through, exactly as
  // it did before, rather than being silently reattached to some other label.
  eq('removing a chip leaves its route alone', removed.next, base.next);

  const two = withChips(base, 'Cards, Signage, Packaging') as typeof base;
  eq('two-for-two is ambiguous, so nothing is guessed', two.next, base.next);

  const plain = withChips({ kind: 'ask', id: 'q1', prompt: 'Hi?', field: 'notes', chips: 'A, B' } as Extract<Step, { kind: 'ask' }>, 'A, C') as typeof base;
  eq('a question with no branches is just a chips edit', plain.next, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
