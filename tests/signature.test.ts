import { renderSignature, signatureFields } from '../src/lib/signature';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const sean = { name: 'Sean Wheelock', email: 'seanw@dumontprinting.com' };
const CO = 'Dumont Printing';

console.log('the four lines');
eq('name / title / company / phone | email',
   renderSignature(sean, CO, { title: 'Account Executive', phone: '(559) 485-6311' }),
   'Sean Wheelock\nAccount Executive\nDumont Printing\n(559) 485-6311 | seanw@dumontprinting.com');

console.log('lines that have nothing in them are dropped, not left blank');
eq('no title', renderSignature(sean, CO, { phone: '(559) 485-6311' }),
   'Sean Wheelock\nDumont Printing\n(559) 485-6311 | seanw@dumontprinting.com');
eq('no phone', renderSignature(sean, CO, { title: 'Account Executive' }),
   'Sean Wheelock\nAccount Executive\nDumont Printing\nseanw@dumontprinting.com');
eq('neither', renderSignature(sean, CO, {}),
   'Sean Wheelock\nDumont Printing\nseanw@dumontprinting.com');
// Nobody should ever receive a mail signed with a dangling separator.
eq('no email either', renderSignature({ name: 'Pat', email: '' }, CO, {}), 'Pat\nDumont Printing');

console.log('what gets stored');
eq('only the two keys', signatureFields({ title: 'AE', phone: '555', company: 'Elsewhere Ltd' }),
   { title: 'AE', phone: '555' });
eq('trimmed', signatureFields({ title: '  AE  ' }), { title: 'AE' });
// A blank means "they have not set one", not "sign off with nothing".
eq('blanks dropped', signatureFields({ title: '   ', phone: '' }), {});
eq('nothing stored', signatureFields(undefined), {});
eq('junk types ignored', signatureFields({ title: 42, phone: ['x'] }), {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
