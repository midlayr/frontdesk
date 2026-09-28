#!/usr/bin/env node
/**
 * Print the SQL to set someone's password.
 *
 * The normal route is Settings → People, or POST /api/users/:id/password with the platform
 * operator token. This exists for the case both are shut: nobody can sign in, so there is no
 * admin session, and the operator token is lost or does not match. All that is left is the
 * database, and a password cannot be written there by hand because the stored value is a
 * PBKDF2 chain, not the password.
 *
 * So: derive the hash here with the same parameters src/auth.ts uses, and print an UPDATE to
 * paste into any SQL console. The password is read from a hidden prompt and never appears in
 * argv, the environment, or shell history. The hash is useless without it.
 *
 *   node scripts/reset-password.mjs you@example.com
 *   node scripts/reset-password.mjs --selftest
 *
 * Keep these three in step with src/auth.ts. They are written into the stored string, so a
 * change here only affects new passwords — existing ones still verify against their own.
 */
const ITERATIONS = 100_000;  // Workers refuses more per call
const ROUNDS = 3;            // chained, so 300k iterations of equivalent work
const SALT_BYTES = 16;

const enc = new TextEncoder();
const b64 = (b) => Buffer.from(new Uint8Array(b)).toString('base64');

async function derive(material, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

async function pbkdf2(password, salt, iterations, rounds) {
  let bits = enc.encode(password).buffer;
  for (let i = 0; i < rounds; i++) bits = await derive(bits, salt, iterations);
  return b64(bits);
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))) {
  return `pbkdf2$${ROUNDS}x${ITERATIONS}$${b64(salt.buffer)}$${await pbkdf2(password, salt, ITERATIONS, ROUNDS)}`;
}

/** The same parse-and-compare the Worker does, so a self-test proves the formats agree. */
async function verifyPassword(password, stored) {
  const [scheme, work, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !work) return false;
  const [rounds, iters] = work.split('x').map(Number);
  const got = await pbkdf2(password, Uint8Array.from(Buffer.from(salt, 'base64')), iters, rounds);
  return got === hash;
}

/** Read without echoing; reads a piped password instead when stdin is not a terminal. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let piped = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { piped += d; });
      stdin.on('end', () => resolve(piped.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
        stdout.write('\n'); resolve(buf);
      } else if (ch === '\u0003') {                 // ctrl-c
        stdin.setRawMode(false); stdout.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function main() {
  const arg = process.argv[2];

  if (arg === '--selftest') {
    const stored = await hashPassword('correct horse battery staple');
    const ok = await verifyPassword('correct horse battery staple', stored);
    const bad = await verifyPassword('wrong password entirely', stored);
    console.log(`format   ${stored.slice(0, stored.indexOf('$', 8))}$…`);
    console.log(`verifies ${ok}`);
    console.log(`rejects  ${!bad}`);
    process.exit(ok && !bad ? 0 : 1);
  }

  if (!arg) {
    console.error('usage: node scripts/reset-password.mjs <email>   (or --selftest)');
    process.exit(2);
  }

  const pw = await askHidden(`New password for ${arg} (min 12 chars, not echoed): `);
  if (pw.length < 12) {
    console.error(`\nToo short — ${pw.length} characters. The API requires 12, so this would`);
    console.error('set a password the app itself would refuse to accept on the next change.');
    process.exit(1);
  }
  const hash = await hashPassword(pw);

  console.log(`
-- Paste into the Neon SQL editor. The set_config line is not optional: users is under
-- FORCE row level security, so without an org pinned the UPDATE matches nothing and
-- reports success having changed no rows.
SELECT set_config('app.org_id', (SELECT id FROM orgs WHERE slug = 'dumont'), false);

UPDATE users
   SET password_hash = ${sqlQuote(hash)},
       password_set_at = now(),
       disabled_at = NULL          -- a disabled account cannot sign in whatever its password
 WHERE email = ${sqlQuote(arg.toLowerCase())}
 RETURNING id, email, role;

-- Any existing sessions belong to the old password.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${sqlQuote(arg.toLowerCase())});
`);
  console.error('If RETURNING shows no rows, that email has no account on this tenant —');
  console.error('list them with:  SELECT id, email, role FROM users ORDER BY created_at;');
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
