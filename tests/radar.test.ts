import { gaps, learnInterval, radarFor } from '../src/lib/radar';

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const d = (s: string) => new Date(s);
const NOW = d('2026-09-21T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

console.log('gaps between orders');
eq('none from a single order', gaps([d('2026-01-01')]), []);
eq('days between two', gaps([d('2026-01-01'), d('2026-01-31')]), [30]);
eq('order does not matter', gaps([d('2026-01-31'), d('2026-01-01')]), [30]);
eq('three orders give two gaps',
   gaps([d('2026-01-01'), d('2026-04-01'), d('2026-07-01')]), [90, 91]);

console.log('learning the rhythm');
eq('one gap is a coincidence, not a rhythm', learnInterval([d('2026-01-01'), d('2026-04-01')]), null);
eq('two gaps give a median',
   learnInterval([d('2026-01-01'), d('2026-04-01'), d('2026-07-01')]), 91);
eq('median resists one outlier — a mean would not',
   learnInterval([d('2026-01-01'), d('2026-01-08'), d('2026-01-15'), d('2027-01-15')]), 7);
eq('same-day repeats are ignored',
   learnInterval([d('2026-01-01'), d('2026-01-01'), d('2026-04-01'), d('2026-07-01')]), 91);
eq('nothing from no orders', learnInterval([]), null);

console.log('where a customer sits');
const base = { lapsedAfterDays: 180, now: NOW };
eq('never ordered is not on the radar',
   radarFor({ ...base, lastOrderAt: null, intervalDays: null }), null);
eq('a known 90-day rhythm, 30 days in, is quiet',
   radarFor({ ...base, lastOrderAt: ago(30), intervalDays: 90 }), null);
eq('at 90% of the rhythm it is due',
   radarFor({ ...base, lastOrderAt: ago(81), intervalDays: 90 }), 'reorder_due');
eq('just under 90% is still quiet',
   radarFor({ ...base, lastOrderAt: ago(80), intervalDays: 90 }), null);
eq('well past the rhythm is lapsed, not still due',
   radarFor({ ...base, lastOrderAt: ago(230), intervalDays: 90 }), 'lapsed');

console.log('customers with no rhythm to learn from');
eq('one order, recent, is not chased',
   radarFor({ ...base, lastOrderAt: ago(60), intervalDays: null }), null);
eq('one order, long ago, is lapsed',
   radarFor({ ...base, lastOrderAt: ago(200), intervalDays: null }), 'lapsed');
eq('a single order never becomes "due" — that would chase every one-off job',
   radarFor({ ...base, lastOrderAt: ago(120), intervalDays: null }), null);
eq('the lapsed threshold is configurable',
   radarFor({ ...base, lapsedAfterDays: 90, lastOrderAt: ago(100), intervalDays: null }), 'lapsed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
