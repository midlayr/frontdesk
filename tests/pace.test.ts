import { fetchEstimatePdf, pdfKey } from '../src/lib/pace';
import type { Env } from '../src/env';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

const env = { PACE_PDF_URL: 'https://crm.dumontapps.test/api/crm/estimate-pdf',
              PACE_API_KEY: 'k' } as Env;

/** Stubs fetch and records what was asked for. */
function stub(...responses: (Response | Error)[]) {
  const calls: { url: string; key: string | null }[] = [];
  let n = 0;
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), key: new Headers(init?.headers).get('x-api-key') });
    const r = responses[Math.min(n++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as typeof fetch;
  return calls;
}
const pdf = (body = '%PDF-1.4 ...') => new Response(body, { status: 200 });
const err = (status: number, body = '') => new Response(body, { status });

console.log('the happy path');
{
  const calls = stub(pdf());
  const r = await fetchEstimatePdf(env, '99802');
  eq('returns the bytes', r.ok && r.bytesLength > 0, true);
  eq('one call', calls.length, 1);
  eq('the key goes up', calls[0].key, 'k');
  eq('the number is in the path', calls[0].url.endsWith('/99802'), true);
}

console.log('the number is text, not a number');
{
  // Their note: some estimate numbers have leading zeros, so converting to an integer
  // would quietly request the wrong estimate.
  const calls = stub(pdf());
  await fetchEstimatePdf(env, '000420');
  eq('leading zeros survive', calls[0].url.endsWith('/000420'), true);

  const c2 = stub(pdf());
  await fetchEstimatePdf(env, '  99802  ');
  eq('but it is trimmed', c2[0].url.endsWith('/99802'), true);
}

console.log('answers, which are not retried');
{
  const c1 = stub(err(400, 'bad'));
  const r1 = await fetchEstimatePdf(env, 'xyz');
  eq('400 → bad number', !r1.ok && r1.why, 'bad_number');
  eq('and is not retried', c1.length, 1);

  const r2 = await (async () => { stub(err(401)); return fetchEstimatePdf(env, '1'); })();
  eq('401 → auth', !r2.ok && r2.why, 'auth');

  // The two 404s are different errands: a wrong number, versus a real estimate that has
  // never had a quote letter made for it.
  stub(err(404, '{"reason":"estimate_not_found"}'));
  const r3 = await fetchEstimatePdf(env, '1');
  eq('404 estimate_not_found', !r3.ok && r3.why, 'estimate_not_found');

  stub(err(404, '{"reason":"no_quote_letter"}'));
  const r4 = await fetchEstimatePdf(env, '1');
  eq('404 no_quote_letter', !r4.ok && r4.why, 'no_quote_letter');

  const c5 = stub(err(404, '{"reason":"estimate_not_found"}'));
  await fetchEstimatePdf(env, '1');
  eq('a 404 is an answer, so no retry', c5.length, 1);
}

console.log('blips, which are');
{
  const c1 = stub(err(502), err(502), pdf());
  const r1 = await fetchEstimatePdf(env, '99802');
  eq('502 then success', r1.ok, true);
  eq('took three goes', c1.length, 3);

  const c2 = stub(err(502));
  const r2 = await fetchEstimatePdf(env, '99802');
  eq('502 throughout gives up', !r2.ok && r2.why, 'upstream');
  eq('after three attempts', c2.length, 3);

  const c3 = stub(new Error('network'), pdf());
  eq('a dead socket is retried', (await fetchEstimatePdf(env, '1')).ok, true);
  eq('twice', c3.length, 2);

  stub(new Error('timed out'));
  const r4 = await fetchEstimatePdf(env, '1');
  eq('never reachable', !r4.ok && r4.why, 'unreachable');
}

console.log('a 200 that is not a PDF');
{
  // A proxy or an error page served with the wrong status would otherwise be attached to a
  // customer's email as a file that does not open.
  const c = stub(new Response('<html>gateway error</html>', { status: 200 }));
  const r = await fetchEstimatePdf(env, '1');
  eq('refused', !r.ok && r.why, 'upstream');
  eq('and says what it got', !r.ok && r.detail.startsWith('not a PDF'), true);
  eq('not retried — it will not fix itself', c.length, 1);
  eq('a real one is accepted', (await (async () => { stub(pdf()); return fetchEstimatePdf(env, '1'); })()).ok, true);
}

console.log('things that are not a PDF');
{
  // A 200 with nothing in it would otherwise be attached as an empty file, which is worse
  // than telling somebody we could not get one.
  const c = stub(pdf(''), pdf(''), pdf(''));
  const r = await fetchEstimatePdf(env, '1');
  eq('an empty 200 is not success', r.ok, false);
  eq('and was retried', c.length, 3);
}

console.log('not switched on');
{
  const r = await fetchEstimatePdf({} as Env, '99802');
  eq('no url or key', !r.ok && r.why, 'not_configured');
  const r2 = await fetchEstimatePdf(env, '   ');
  eq('no number on the ticket', !r2.ok && r2.why, 'bad_number');
}

console.log('where it is kept');
eq('dated, because the report regenerates',
   pdfKey('org1', '99802', new Date('2026-10-12T09:00:00Z')),
   'org/org1/estimates/99802-2026-10-12.pdf');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
