import { TOKENS, fill, heldReason } from '../src/lib/drip';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

console.log('the two new tokens exist');
eq('{estimate_no}', (TOKENS as readonly string[]).includes('estimate_no'), true);
eq('{sender_signature}', (TOKENS as readonly string[]).includes('sender_signature'), true);

console.log('filling them');
{
  const v = { estimate_no: 'E-10482', sender_signature: 'Sean Wheelock\nDumont Printing' };
  eq('the estimate number lands',
     fill('Your estimate {estimate_no} is ready.', v).text,
     'Your estimate E-10482 is ready.');
  eq('a multi-line signature lands whole',
     fill('Thanks,\n{sender_signature}', v).text,
     'Thanks,\nSean Wheelock\nDumont Printing');
}

console.log('and when we do not have them');
{
  // A blank is never substituted — "Your estimate  is ready" reads as a mistake to the
  // customer and as a successful send to us, which is the worst of both.
  const r = fill('Your estimate {estimate_no} is ready.', { estimate_no: null });
  eq('the token is left intact', r.text, 'Your estimate {estimate_no} is ready.');
  eq('and reported as missing', r.missing, ['estimate_no']);
  eq('which holds the send', heldReason(r.missing), 'missing:{estimate_no}');

  eq('an empty signature counts as missing',
     fill('{sender_signature}', { sender_signature: '   ' }).missing, ['sender_signature']);
}

console.log('what Summer actually typed');
// She asked for "{estimate #}". A token is \w+, so that is not one — it would be sent to a
// customer verbatim. Worth saying out loud rather than letting it surface in their inbox.
{
  const r = fill('Estimate {estimate #} attached', { estimate_no: 'E-1' });
  eq('{estimate #} is not substituted', r.text, 'Estimate {estimate #} attached');
  eq('and is not even reported missing', r.missing, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
