import { DEFAULT_HOURS, describe as describeHours, hoursOf, openAt, clock } from '../src/lib/hours';
import { simulate } from '../src/flow-engine';
import type { Step } from '../src/env';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// Dumont's hours, as Summer wrote them: M–F 8:30–5 Pacific.
const H = DEFAULT_HOURS;
/** A moment in Pacific wall-clock terms, built in UTC so the test does not depend on TZ. */
const pacific = (iso: string) => new Date(iso);

console.log('open and shut');
// 2026-10-12 is a Monday. Pacific is UTC-7 in October.
eq('Monday 9am  → open',   openAt(H, pacific('2026-10-12T16:00:00Z')), true);
eq('Monday 8:00 → shut',   openAt(H, pacific('2026-10-12T15:00:00Z')), false);
eq('Monday 8:30 → open',   openAt(H, pacific('2026-10-12T15:30:00Z')), true);
// The close time is the moment the door shuts, not the last minute you are welcome.
eq('Monday 17:00 → shut',  openAt(H, pacific('2026-10-13T00:00:00Z')), false);
eq('Monday 16:59 → open',  openAt(H, pacific('2026-10-12T23:59:00Z')), true);
eq('Saturday noon → shut', openAt(H, pacific('2026-10-17T19:00:00Z')), false);
eq('Sunday noon → shut',   openAt(H, pacific('2026-10-18T19:00:00Z')), false);

console.log('hours as a person says them');
eq('a weekday run collapses', describeHours(H), '8:30 AM – 5:00 PM Monday through Friday');
eq('one day stands alone',
   describeHours({ ...H, days: [6] }), '8:30 AM – 5:00 PM Saturday');
eq('a scattered week is listed',
   describeHours({ ...H, days: [1, 3, 5] }), '8:30 AM – 5:00 PM Mon, Wed, Fri');
eq('no days at all', describeHours({ ...H, days: [] }), 'by appointment');
eq('noon is 12 PM, not 0', clock('12:00'), '12:00 PM');
eq('midnight is 12 AM', clock('00:30'), '12:30 AM');

console.log('what gets stored');
// Half a set of hours would shut the shop at a time nobody chose, and the first anyone
// would know of it is a customer being told the wrong thing.
eq('a lost end falls back whole', hoursOf({ days: [1], start: '09:00' }), DEFAULT_HOURS);
eq('a bad time falls back whole', hoursOf({ ...H, end: '25:00' }), DEFAULT_HOURS);
eq('nothing stored yet', hoursOf(null), DEFAULT_HOURS);
eq('junk days are dropped', hoursOf({ ...H, days: [1, 9, 'x'] }).days, [1]);
eq('a good set survives', hoursOf({ days: [6, 7], start: '10:00', end: '14:00', tz: 'UTC' }),
   { days: [6, 7], start: '10:00', end: '14:00', tz: 'UTC' });

console.log('what the bot says at the end');
{
  const steps: Step[] = [
    { kind: 'ask', id: 'a1', prompt: 'What are you printing?', field: 'product' },
    { kind: 'ticket', text: 'Thanks — your request is in. We will reach out soon.',
      after_hours_text: 'Thanks — your request is in. We are open 8:30 AM – 5:00 PM Monday through Friday.' },
  ];
  const last = (r: ReturnType<typeof simulate>) => r.next.turns[r.next.turns.length - 1].text;

  eq('open: the normal line', last(simulate(steps, ['Banners'], true)),
     'Thanks — your request is in. We will reach out soon.');
  eq('shut: the out-of-hours line', last(simulate(steps, ['Banners'], false)),
     'Thanks — your request is in. We are open 8:30 AM – 5:00 PM Monday through Friday.');

  // Turning hours on must not leave anyone with a blank goodbye.
  const noAfter: Step[] = [steps[0], { kind: 'ticket', text: 'Thanks — your request is in.' }];
  eq('no out-of-hours wording written yet', last(simulate(noAfter, ['Banners'], false)),
     'Thanks — your request is in.');
  const blank: Step[] = [steps[0], { kind: 'ticket', text: 'Thanks.', after_hours_text: '   ' }];
  eq('blank is treated as unwritten', last(simulate(blank, ['Banners'], false)), 'Thanks.');

  // Default stays open, so nothing that existed before this behaves differently.
  eq('the default is open', last(simulate(steps, ['Banners'])),
     'Thanks — your request is in. We will reach out soon.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
