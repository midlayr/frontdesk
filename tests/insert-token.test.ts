/*
 * flows-api/campaigns-api read browser globals at module scope, so they are stubbed before
 * the import. Only insertToken is under test and it touches none of them.
 */
const g = globalThis as Record<string, unknown>;
g.location = { search: '?org=dumont', origin: 'http://localhost' };
const store = new Map<string, string>();
const shim = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
g.localStorage = shim;
g.sessionStorage = shim;

const { insertToken } = await import('../web/src/campaigns-api');

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const base = { token: 'product', kind: 'email', subject: 'Checking in', body: 'Hello there.' };

console.log('the chip goes where you were typing');
{
  // The bug: this always wrote to the body, so clicking a token while writing a subject
  // put it somewhere else and looked like subjects do not accept tokens.
  const r = insertToken({ ...base, into: 'subject', start: 8, end: 8 });
  eq('into the subject', r.field, 'subject');
  // index 8 is the end of "Checking", before the space.
  eq('at the cursor', r.text, 'Checking{product} in');
  eq('and the caret follows it', r.caret, 17);
}
{
  const r = insertToken({ ...base, into: 'body', start: 5, end: 5 });
  eq('into the body', r.field, 'body');
  eq('at the cursor', r.text, 'Hello{product} there.');
}

console.log('a selection is replaced, not pushed aside');
eq('subject selection', insertToken({ ...base, into: 'subject', start: 0, end: 8 }).text,
   '{product} in');

console.log('no cursor yet');
eq('appended to the subject',
   insertToken({ ...base, into: 'subject' }).text, 'Checking in{product}');

console.log('steps with no subject at all');
{
  // An SMS or a task has only a body, so focus cannot have been in a subject that is not
  // rendered — it must never write to a field the step does not have.
  for (const kind of ['sms', 'task', 'wait']) {
    eq(`${kind} always takes the body`,
       insertToken({ ...base, kind, into: 'subject', start: 0, end: 0 }).field, 'body');
  }
}

console.log('an empty subject');
eq('starts it off', insertToken({ ...base, subject: '', into: 'subject' }).text, '{product}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
