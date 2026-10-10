import { leadNotice, type LeadFacts } from '../src/lib/lead-notice';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};

const base: LeadFacts = {
  ticketNo: 'DL-2046', company: 'Fresno Ag Hardware', contactName: 'Trina Beltrán',
  contactEmail: 'trina@fresnoaghardware.test', contactPhone: '+15595550193',
  description: null, product: 'Business cards', qty: 500,
  answers: [['notes', "What's the artwork like — Print-ready PDF\nAny special finishing — Spot UV"]],
  repName: 'Susan Moore', ticketUrl: 'https://example.test/?lead=l1',
};

console.log('a rep the customer named');
{
  const l = leadNotice(base);
  eq('the ticket and who it is for', l.heading, 'DL-2046 · Fresno Ag Hardware');
  // The first thing a named rep should learn is why it came to them.
  eq('leads with the reason it is theirs', l.body[0], 'Fresno Ag Hardware asked for you by name.');
  eq('what the job is', l.body[1], '500 × Business cards');
  eq('and how to reach them', l.body[2], 'Trina Beltrán · trina@fresnoaghardware.test · +15595550193');
  eq('the answers are unpacked a line each', l.body.slice(3),
     ["What's the artwork like — Print-ready PDF", 'Any special finishing — Spot UV']);
  eq('says it is already theirs', l.fine, 'You are the rep on this one, so it is already assigned to you.');
  eq('a button to the ticket', l.action?.url, 'https://example.test/?lead=l1');
}

console.log('nobody named');
{
  const l = leadNotice({ ...base, repName: null });
  eq('a neutral opening', l.body[0], 'Fresno Ag Hardware has sent in a job through the website chat.');
  // Whoever gets this must not assume someone else has it.
  eq('and says nobody has it', l.fine, 'Nobody is on this yet — it is sitting in the queue for whoever picks it up.');
}

console.log('what we do not know yet');
{
  const bare = leadNotice({
    ...base, company: null, contactName: null, contactEmail: null, contactPhone: null,
    product: null, qty: null, description: null, answers: [], repName: null,
  });
  eq('no name at all still reads', bare.heading, 'DL-2046 · Someone');
  // No empty bullets, no "null ×" — a line is only there when it says something.
  eq('nothing hollow in the body', bare.body, ['Someone has sent in a job through the website chat.']);

  eq('a company we lack falls back to the person',
     leadNotice({ ...base, company: null }).heading, 'DL-2046 · Trina Beltrán');
  eq('quantity alone is enough',
     leadNotice({ ...base, product: null }).body[1], '500');
  eq('so is a product alone',
     leadNotice({ ...base, qty: null }).body[1], 'Business cards');
  eq('with neither, the written description stands in',
     leadNotice({ ...base, product: null, qty: null, description: 'Counter cards, fall promo' }).body[1],
     'Counter cards, fall promo');
}

console.log('it stays short enough to read');
{
  const many: [string, string][] = Array.from({ length: 9 },
    (_, i) => [`f${i}`, `line ${i}a\nline ${i}b\nline ${i}c\nline ${i}d`]);
  const l = leadNotice({ ...base, answers: many });
  // Four answers, three lines each, on top of the three opening lines.
  eq('capped rather than reprinting the conversation', l.body.length <= 3 + 4 * 3, true);
  eq('and it is the first answers that survive', l.body[3], 'line 0a');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
