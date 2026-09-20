import { createHmac } from 'node:crypto';
import { verifyMailgun } from '../src/lib/mailgun';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const KEY = 'test-signing-key';
const sign = (ts: string, token: string, key = KEY) =>
  createHmac('sha256', key).update(ts + token).digest('hex');

const now = 1_800_000_000_000;
const ts = String(Math.floor(now / 1000));
const token = 'abc123token';

console.log('mailgun webhook signature');
eq('a correct signature verifies',
   await verifyMailgun(KEY, ts, token, sign(ts, token), now), true);
eq('uppercase hex still verifies',
   await verifyMailgun(KEY, ts, token, sign(ts, token).toUpperCase(), now), true);
eq('a wrong signature is refused',
   await verifyMailgun(KEY, ts, token, sign(ts, 'other-token'), now), false);
eq('a signature made with another key is refused',
   await verifyMailgun(KEY, ts, token, sign(ts, token, 'wrong-key'), now), false);
eq('a tampered token is refused',
   await verifyMailgun(KEY, ts, 'tampered', sign(ts, token), now), false);

console.log('replay protection');
{
  const old = String(Math.floor((now - 10 * 60_000) / 1000));
  eq('a valid signature from ten minutes ago is refused',
     await verifyMailgun(KEY, old, token, sign(old, token), now), false);
  const soon = String(Math.floor((now + 60_000) / 1000));
  eq('a minute of clock skew is tolerated',
     await verifyMailgun(KEY, soon, token, sign(soon, token), now), true);
  const future = String(Math.floor((now + 10 * 60_000) / 1000));
  eq('ten minutes into the future is not',
     await verifyMailgun(KEY, future, token, sign(future, token), now), false);
}

console.log('missing pieces');
eq('no signing key configured refuses everything',
   await verifyMailgun('', ts, token, sign(ts, token), now), false);
eq('empty signature', await verifyMailgun(KEY, ts, token, '', now), false);
eq('empty timestamp', await verifyMailgun(KEY, '', token, sign('', token), now), false);
eq('non-numeric timestamp',
   await verifyMailgun(KEY, 'not-a-time', token, sign('not-a-time', token), now), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
