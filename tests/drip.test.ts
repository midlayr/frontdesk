import {
  DEFAULT_WINDOW, fill, heldFields, heldReason, isOpen, localParts, nextOpen, stopReason,
  type SendWindow, type Standing,
} from '../src/lib/drip';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const LA = 'America/Los_Angeles';
const W: SendWindow = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', tz: LA };
/** A wall-clock time in Los Angeles, written as the UTC instant it corresponds to. */
const at = (iso: string) => new Date(iso);

console.log('send window · open and closed');
// 2026-09-21 is a Monday. LA is UTC-7 in September (PDT).
eq('Monday 09:00 LA is open', isOpen(at('2026-09-21T16:00:00Z'), W), true);
eq('Monday 07:59 LA is closed', isOpen(at('2026-09-21T14:59:00Z'), W), false);
eq('Monday 08:00 LA is open on the boundary', isOpen(at('2026-09-21T15:00:00Z'), W), true);
eq('Monday 17:00 LA is closed on the boundary', isOpen(at('2026-09-22T00:00:00Z'), W), false);
eq('Saturday midday is closed', isOpen(at('2026-09-26T19:00:00Z'), W), false);
eq('Sunday midday is closed', isOpen(at('2026-09-27T19:00:00Z'), W), false);

console.log('send window · when it next opens');
eq('inside the window, send now',
   nextOpen(at('2026-09-21T16:00:00Z'), W)?.toISOString(), '2026-09-21T16:00:00.000Z');
eq('before it opens, wait for 08:00 the same day',
   nextOpen(at('2026-09-21T13:00:00Z'), W)?.toISOString(), '2026-09-21T15:00:00.000Z');
// 18:00 PDT Monday — past the 17:00 close, which is 00:00Z on the Tuesday.
eq('after it closes, 08:00 the next weekday',
   nextOpen(at('2026-09-22T01:00:00Z'), W)?.toISOString(), '2026-09-22T15:00:00.000Z');
eq('Friday night waits until Monday',
   nextOpen(at('2026-09-26T02:00:00Z'), W)?.toISOString(), '2026-09-28T15:00:00.000Z');
eq('Saturday waits until Monday',
   nextOpen(at('2026-09-26T19:00:00Z'), W)?.toISOString(), '2026-09-28T15:00:00.000Z');

console.log('send window · daylight saving');
{
  // US clocks go back on 2026-11-01, so LA moves from UTC-7 (PDT) to UTC-8 (PST).
  const before = nextOpen(at('2026-10-24T01:00:00Z'), W);   // Fri 18:00 PDT → Mon 26 Oct
  eq('08:00 before the change is 15:00Z', before?.toISOString(), '2026-10-26T15:00:00.000Z');
  const after = nextOpen(at('2026-11-03T02:00:00Z'), W);    // Mon 18:00 PST → Tue 3 Nov
  eq('08:00 after the change is 16:00Z', after?.toISOString(), '2026-11-03T16:00:00.000Z');
  // A different UTC instant either side, but the same time on the wall — which is the point.
  eq('the same wall-clock hour either side',
     [localParts(before!, LA).minute, localParts(after!, LA).minute], [480, 480]);
}

console.log('send window · a window that can never open');
eq('no days at all', nextOpen(at('2026-09-21T16:00:00Z'), { ...W, days: [] }), null);
eq('end before start', nextOpen(at('2026-09-21T16:00:00Z'), { ...W, start: '17:00', end: '08:00' }), null);
eq('end equal to start', nextOpen(at('2026-09-21T16:00:00Z'), { ...W, start: '09:00', end: '09:00' }), null);
eq('a nonsense time', nextOpen(at('2026-09-21T16:00:00Z'), { ...W, start: '99:99' }), null);
eq('weekend-only windows still resolve',
   nextOpen(at('2026-09-21T16:00:00Z'), { ...W, days: [6, 7] })?.toISOString(),
   '2026-09-26T15:00:00.000Z');
eq('the platform default is a weekday window', DEFAULT_WINDOW.days, [1, 2, 3, 4, 5]);

console.log('stop checks');
const ok: Standing = { optedOut: false, leadStatus: 'quoted', archived: false, inboundSince: false, repRepliedSince: false };
eq('a quoted lead with no reply keeps sending', stopReason(ok), null);
eq('opt-out stops it', stopReason({ ...ok, optedOut: true }), 'opted_out');
eq('a reply stops it', stopReason({ ...ok, inboundSince: true }), 'replied');
eq('a rep replying by hand pauses it', stopReason({ ...ok, repRepliedSince: true }), 'paused');
eq('won completes it', stopReason({ ...ok, leadStatus: 'won' }), 'completed');
eq('lost completes it', stopReason({ ...ok, leadStatus: 'lost' }), 'completed');
eq('spam completes it', stopReason({ ...ok, leadStatus: 'spam' }), 'completed');
eq('archiving completes it', stopReason({ ...ok, archived: true }), 'completed');
eq('new and replied statuses keep sending', stopReason({ ...ok, leadStatus: 'new' }), null);

console.log('stop checks · which reason wins');
eq('opt-out beats a reply', stopReason({ ...ok, optedOut: true, inboundSince: true }), 'opted_out');
eq('opt-out beats won', stopReason({ ...ok, optedOut: true, leadStatus: 'won' }), 'opted_out');
eq('a reply beats won — they answered before it was marked',
   stopReason({ ...ok, inboundSince: true, leadStatus: 'won' }), 'replied');
eq('a customer reply beats a rep reply',
   stopReason({ ...ok, inboundSince: true, repRepliedSince: true }), 'replied');

console.log('merge tokens');
const ctx = { first_name: 'Maria', qty: 2500, product: 'tri-fold brochures', rep_name: 'Susan' };
eq('tokens are substituted',
   fill('Hi {first_name}, about the {qty} {product}.', ctx).text,
   'Hi Maria, about the 2500 tri-fold brochures.');
eq('nothing missing when they all resolve', fill('Hi {first_name}.', ctx).missing, []);
eq('a number resolves', fill('{qty}', ctx).text, '2500');
eq('the same token twice', fill('{first_name} {first_name}', ctx).text, 'Maria Maria');
eq('text with no tokens is untouched', fill('Plain sentence.', ctx).text, 'Plain sentence.');

console.log('merge tokens · held rather than sent blank');
eq('an absent value is reported', fill('Hi {first_name}, {qty} of {stock}?', ctx).missing, ['stock']);
eq('and left in the text, not blanked',
   fill('Hi {first_name}, {qty} of {stock}?', ctx).text, 'Hi Maria, 2500 of {stock}?');
eq('null counts as missing', fill('{size}', { size: null }).missing, ['size']);
eq('empty string counts as missing', fill('{size}', { size: '' }).missing, ['size']);
eq('whitespace counts as missing', fill('{size}', { size: '   ' }).missing, ['size']);
eq('zero does not', fill('{qty}', { qty: 0 }).text, '0');
eq('each missing token reported once', fill('{a} {a} {b}', {}).missing, ['a', 'b']);
eq('an unknown token is missing, not silently dropped', fill('{nope}', ctx).missing, ['nope']);

console.log('held reasons round-trip');
eq('formats the reason', heldReason(['qty']), 'missing:{qty}');
eq('formats several', heldReason(['qty', 'stock']), 'missing:{qty} {stock}');
eq('reads the fields back', heldFields('missing:{qty} {stock}'), ['qty', 'stock']);
eq('a non-held reason has no fields', heldFields('bounced'), []);
eq('null is safe', heldFields(null), []);
eq('round trip', heldFields(heldReason(['product', 'deadline'])), ['product', 'deadline']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
