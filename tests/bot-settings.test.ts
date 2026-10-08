import { presentation } from '../src/lib/flow-settings';
import { cleanDomains, hostOnly } from '../src/lib/domains';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

console.log('per-bot wording');
eq('both words kept',
   presentation({ launcher: 'Reorder', nudge: 'Need the same again?' }),
   { launcher: 'Reorder', nudge: 'Need the same again?' });
eq('trimmed', presentation({ launcher: '  Reorder  ' }), { launcher: 'Reorder' });
// A blank must drop out rather than be stored, or the shop gets a button with no label
// instead of falling back to its own wording.
eq('blank dropped, not stored', presentation({ launcher: '', nudge: '   ' }), {});
eq('an unconfigured bot is an empty object, never null', presentation(null), {});
eq('non-strings ignored', presentation({ launcher: 42, nudge: ['a'] }), {});

console.log('a bot cannot reach beyond its own wording');
// The column is jsonb: a row written by hand, by a migration, or by a later version of the
// code could hold anything, and this is what stops it reaching the widget.
eq('allowed_domains is not a bot setting',
   presentation({ launcher: 'ok', allowed_domains: ['evil.test'] }), { launcher: 'ok' });
eq('nothing else survives either',
   presentation({ position: 'left', show_powered_by: false }), {});

console.log('the widget merge');
{
  const org = { launcher: 'Get a quote', nudge: 'Shop default',
                allowed_domains: ['dumontprinting.com'], position: 'right' };
  eq("the bot's label wins",
     { ...org, ...presentation({ launcher: 'Reorder' }) },
     { launcher: 'Reorder', nudge: 'Shop default',
       allowed_domains: ['dumontprinting.com'], position: 'right' });
  eq("a bot that sets nothing shows the shop's wording",
     { ...org, ...presentation({}) }, org);
  eq('the allowlist cannot be widened from a flow',
     { ...org, ...presentation({ allowed_domains: ['evil.test'] }) }.allowed_domains,
     ['dumontprinting.com']);
}

console.log('domain allowlist');
eq('a bare domain', hostOnly('dumontprinting.com'), 'dumontprinting.com');
// People paste what is in their address bar, which is the whole URL.
eq('a pasted URL keeps only the host', hostOnly('https://www.dumontprinting.com/quotes?a=1'),
   'www.dumontprinting.com');
eq('scheme-less with a path', hostOnly('dumontprinting.com/quote'), 'dumontprinting.com');
eq('case folded', hostOnly('DumontPrinting.COM'), 'dumontprinting.com');
eq('whitespace trimmed', hostOnly('  shop.dumontprinting.com '), 'shop.dumontprinting.com');
eq('localhost, for testing against a local copy', hostOnly('localhost'), 'localhost');
eq('localhost with a port', hostOnly('http://localhost:5173'), 'localhost');
eq('the wildcard passes through', hostOnly('*'), '*');
eq('a single label is not a domain', hostOnly('dumontprinting'), null);
eq('nor is a sentence', hostOnly('our website'), null);
eq('nor is empty', hostOnly(''), null);
eq('an email address is not a domain', hostOnly('summer@dumontprinting.com'), null);

console.log('cleaning a submitted list');
eq('de-duplicated, including after normalising',
   cleanDomains(['dumontprinting.com', 'https://dumontprinting.com/', 'DUMONTPRINTING.COM']),
   { domains: ['dumontprinting.com'], rejected: [] });
// Reported rather than silently dropped: "I added it and it is not in the list" is worse
// than being told the value made no sense.
eq('junk is reported, the rest still saves',
   cleanDomains(['dumontprinting.com', 'not a domain', '']),
   { domains: ['dumontprinting.com'], rejected: ['not a domain'] });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
