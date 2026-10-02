import { useEffect, useState } from 'react';
import { ROLES, api, type OrgUser, type ProviderCheck } from './api';

/**
 * The people who can use Front Desk, and what each of them may do.
 *
 * Adding someone sends them a link. They click it and they are in — no password invented on
 * their behalf, nothing read out over the phone, nothing for an admin to know. An account
 * still starts with no password, which remains the safe state; the difference is that the
 * person can now let themselves in rather than waiting on somebody.
 *
 * The screen leads with each person's real state, because "added" and "actually using it"
 * are different things and the gap between them is where a rollout quietly stalls. Invited ·
 * Active · Never signed in · Disabled, said plainly, with the action that moves them on.
 *
 * Nobody is ever deleted. Seven tables reference a user, so removing one would take ticket
 * history, assignments and audit rows with it; disabling ends their sessions instead.
 */

const BLANK = { name: '', email: '', role: 'sales' as 'sales' | 'admin' };

/** Rough and deliberately so — "3 days ago" is what a reader wants, not a timestamp. */
function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return `${Math.round(d / 30)} months ago`;
}

type State = { label: string; tone: 'ok' | 'wait' | 'off'; why: string };

function stateOf(u: OrgUser): State {
  if (u.disabled_at) return { label: 'Disabled', tone: 'off', why: 'Signed out and cannot get back in' };
  if (u.last_seen_at) {
    return { label: 'Active', tone: 'ok', why: `Last here ${ago(u.last_seen_at)}` };
  }
  if (u.password_set_at) return { label: 'Never signed in', tone: 'wait', why: 'Has a password but has not used it' };
  return { label: 'Invited', tone: 'wait', why: 'Waiting on them to open their link' };
}

export function Team({ me }: { me: { id: string; role: string } | null }) {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [draft, setDraft] = useState(BLANK);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pw, setPw] = useState('');

  const isAdmin = me?.role === 'admin';
  const load = () => api.users().then(setUsers).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, []);

  async function run(key: string, what: () => Promise<unknown>, ok: string) {
    setBusy(key); setError(''); setNote('');
    try { await what(); await load(); setNote(ok); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }

  const addAndInvite = () => run('add', async () => {
    const name = draft.name.trim(), email = draft.email.trim();
    if (!name || !email) throw new Error('Name and email are both needed');
    const created = await api.addUser({ name, email, role: draft.role });
    // Two calls rather than one: the account exists even if the mail does not go out, so a
    // send failure is "invite them again", not "they were never added".
    await api.inviteUser(created.user.id);
    setDraft(BLANK); setAdding(false);
  }, 'Added, and their sign-in link is on its way.');

  const savePassword = (id: string) => run('pw', async () => {
    if (pw.length < 12) throw new Error('A password needs at least 12 characters');
    await api.setPassword(id, pw);
    setPw(''); setPwFor(null);
  }, 'Password set. Pass it on through something other than email.');

  const waiting = users.filter((u) => !u.disabled_at && !u.last_seen_at).length;

  return (
    <div className="team">
      <div className="team-head">
        <div className="section" style={{ margin: 0 }}>People</div>
        {isAdmin && !adding && (
          <button className="btn-primary" onClick={() => { setAdding(true); setError(''); setNote(''); }}>
            Invite someone
          </button>
        )}
      </div>

      {!isAdmin && (
        <p className="team-note">Only an admin can invite people or change what they can do.</p>
      )}

      {isAdmin && adding && (
        <div className="invite-card">
          <div className="label">Invite someone</div>
          <p className="invite-sub">
            They get an email with a link that signs them in. It lasts seven days and works once.
            No password needed — they can set one later if they want.
          </p>
          <div className="invite-grid">
            <label className="fb-field">
              <span className="label">Full name</span>
              <input value={draft.name} autoFocus placeholder="Summer Hopson"
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="fb-field">
              <span className="label">Email</span>
              <input value={draft.email} type="email" placeholder="name@dumontprinting.com"
                     onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </label>
          </div>
          <div className="role-pick">
            {ROLES.map((r) => (
              <button key={r.id} type="button" data-on={draft.role === r.id}
                      onClick={() => setDraft({ ...draft, role: r.id })}>
                <b>{r.label}</b><span>{r.can}</span>
              </button>
            ))}
          </div>
          <div className="invite-acts">
            <button className="btn-primary" disabled={busy === 'add'} onClick={addAndInvite}>
              {busy === 'add' ? 'Sending…' : 'Send invite'}
            </button>
            <button className="btn-ghost" onClick={() => { setAdding(false); setDraft(BLANK); }}>Cancel</button>
          </div>
        </div>
      )}

      {waiting > 0 && (
        <p className="team-note">
          {waiting} {waiting === 1 ? 'person has' : 'people have'} not signed in yet.
        </p>
      )}

      <ul className="people">
        {users.map((u) => {
          const self = u.id === me?.id;
          const st = stateOf(u);
          const off = !!u.disabled_at;
          return (
            <li key={u.id} className={off ? 'person off' : 'person'}>
              <div className="person-who">
                <div className="person-name">
                  {u.name}{self && <i className="team-you">you</i>}
                  <span className={`pill ${st.tone}`}>{st.label}</span>
                </div>
                <div className="person-mail">{u.email}</div>
                <div className="person-why">{st.why}</div>
              </div>

              <div className="person-role">
                {isAdmin && !self ? (
                  <select value={u.role} disabled={!!busy}
                          onChange={(e) => run('role', () => api.updateUser(u.id, { role: e.target.value }), 'Role changed.')}>
                    {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                ) : (
                  <span className="team-role">{ROLES.find((r) => r.id === u.role)?.label ?? u.role}</span>
                )}
              </div>

              {isAdmin && (
                <div className="person-acts">
                  {!off && (
                    <button disabled={busy === `inv-${u.id}`}
                            onClick={() => run(`inv-${u.id}`, () => api.inviteUser(u.id),
                              `Sign-in link sent to ${u.email}.`)}>
                      {busy === `inv-${u.id}` ? 'Sending…' : u.last_seen_at ? 'Send sign-in link' : 'Resend invite'}
                    </button>
                  )}
                  <button onClick={() => { setPwFor(pwFor === u.id ? null : u.id); setPw(''); }}>
                    {u.password_set_at ? 'Reset password' : 'Set a password'}
                  </button>
                  {!self && (
                    <button className="danger" disabled={!!busy}
                            onClick={() => run('dis', () => api.updateUser(u.id, { disabled: !off }),
                              off ? 'Access restored.' : 'Access removed.')}>
                      {off ? 'Enable' : 'Disable'}
                    </button>
                  )}
                </div>
              )}

              {pwFor === u.id && (
                <div className="team-pw">
                  <span className="label">
                    Password for {u.name}<i> · at least 12 characters · ends their current sessions</i>
                  </span>
                  <div className="team-pw-row">
                    <input type="password" value={pw} autoComplete="new-password" autoFocus
                           onChange={(e) => setPw(e.target.value)} placeholder="new password" />
                    <button className="btn-primary" disabled={busy === 'pw'} onClick={() => savePassword(u.id)}>Set</button>
                    <button className="btn-ghost" onClick={() => { setPwFor(null); setPw(''); }}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && <p className="team-err">{error}</p>}
      {note && !error && <p className="team-ok">{note}</p>}

      {isAdmin && <Health />}
    </div>
  );
}

/**
 * Whether the things this product depends on are actually working.
 *
 * Every provider failure here has been silent — a truncated Twilio SID, a disabled Mailgun
 * key, a cancelled Mailgun subscription — because the code that uses them is careful not to
 * leak information when it fails. Correct, and exactly why nobody noticed for days. This
 * asks each one a harmless question and prints the answer.
 */
function Health() {
  const [rows, setRows] = useState<ProviderCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState('');

  const check = async () => {
    setChecking(true); setErr('');
    try { setRows((await api.providerHealth()).providers); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  };
  useEffect(() => { check(); }, []);

  const bad = rows?.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="health">
      <div className="team-head">
        <div className="section" style={{ margin: 0 }}>
          Connections{rows && bad > 0 && <span className="pill off" style={{ marginLeft: 8 }}>{bad} need attention</span>}
        </div>
        <button className="btn-ghost" disabled={checking} onClick={check}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>

      {err && <p className="team-err">{err}</p>}
      {!rows && !err && <p className="team-note">Checking…</p>}

      {rows && (
        <ul className="health-list">
          {rows.map((r) => (
            <li key={r.name} className={r.ok ? 'hz ok' : 'hz bad'}>
              <span className="hz-dot" aria-hidden="true" />
              <div className="hz-what">
                <b>{r.name}</b>
                <span>{r.detail}</span>
              </div>
              <div className="hz-note">{r.note}</div>
              <div className="hz-ms">{r.ms}ms</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
