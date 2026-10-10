import { matchRep } from '../src/lib/rep-match';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// Dumont's seven, as Summer listed them.
const team = [
  { id: 'u1', name: 'Susan Moore', email: 'susanm@dumontprinting.com' },
  { id: 'u2', name: 'Sean Wheelock', email: 'seanw@dumontprinting.com' },
  { id: 'u3', name: 'Jeff Renn', email: 'jeffr@dumontprinting.com' },
  { id: 'u4', name: 'Gayle Takakjian-Gilbert', email: 'gayleg@dumontprinting.com' },
  { id: 'u5', name: 'Amanda Nicassio', email: 'amandan@dumontprinting.com' },
  { id: 'u6', name: 'Lloyd Paine', email: 'lloydp@dumontprinting.com' },
  { id: 'u7', name: 'Wade Cox', email: 'wadec@dumontprinting.com' },
];
const id = (r: ReturnType<typeof matchRep>) => (r.ok ? r.id : `${r.why}`);

console.log('a chip label finds its person');
eq('exact', id(matchRep('Susan Moore', team)), 'u1');
eq('the hyphenated name', id(matchRep('Gayle Takakjian-Gilbert', team)), 'u4');

console.log('the drift between a flow and the Team page');
// Each of these is a real way the two get out of step; none should break routing.
eq('different case', id(matchRep('SUSAN MOORE', team)), 'u1');
eq('a double space', id(matchRep('Susan  Moore', team)), 'u1');
eq('padding from the chips list', id(matchRep('  Wade Cox ', team)), 'u7');
eq('hyphen typed as a space', id(matchRep('Gayle Takakjian Gilbert', team)), 'u4');
eq('a stray trailing comma', id(matchRep('Jeff Renn,', team)), 'u3');

console.log('what it refuses to guess');
// Routing a customer's job to the wrong rep is worse than not routing it: the ticket simply
// stays on the desk, which is where it would have been without the question.
eq('a first name alone', id(matchRep('Susan', team)), 'unknown');
eq('a surname alone', id(matchRep('Moore', team)), 'unknown');
eq('a near miss is not a match', id(matchRep('Suzan Moore', team)), 'unknown');
eq('somebody who left', id(matchRep('Pat Olsen', team)), 'unknown');
eq('no answer at all', id(matchRep(undefined, team)), 'blank');
eq('an empty answer', id(matchRep('   ', team)), 'blank');

console.log('two people with the same name');
{
  const twins = [...team, { id: 'u8', name: 'Susan Moore', email: 'susan.moore@dumontprinting.com' }];
  // Reported apart from 'unknown': this one is a records problem for an admin to settle,
  // not a chip that drifted.
  eq('refused, and said so', id(matchRep('Susan Moore', twins)), 'ambiguous');
}

console.log('what comes back on a hit');
{
  const r = matchRep('sean wheelock', team);
  eq('the email, for notifying them', r.ok && r.email, 'seanw@dumontprinting.com');
  eq('and their name as the shop spells it', r.ok && r.name, 'Sean Wheelock');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
