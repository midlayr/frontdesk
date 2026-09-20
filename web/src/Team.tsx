import { useEffect, useState } from 'react';
import { ROLES, api, type OrgUser } from './api';

/**
 * The people who can use Front Desk, and what each of them may do.
 *
 * Accounts are created without a password on purpose: an account nobody can sign into yet
 * is the safe state to leave one in, and the admin sets the first password deliberately.
 * There is no email invite because there is no email channel yet — when there is, this
 * becomes "send invite" and the set-password box becomes the reset path.
 *
 * Nobody is ever deleted. Seven tables reference a user, so removing one would take ticket
 * history, assignments and audit rows with it; disabling ends their sessions instead.
 */

const BLANK = { name: '', email: '', role: 'sales' as const };

export function Team({ me }: { me: { id: string; role: string } | null }) {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [draft, setDraft] = useState<typeof BLANK>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pw, setPw] = useState('');

  const isAdmin = me?.role === 'admin';

  const load = () => api.users().then(setUsers).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, []);

  async function run(what: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(''); setNote('');
    try { await what(); await load(); setNote(ok); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const add = () => run(async () => {
    if (!draft.name.trim() || !draft.email.trim()) throw new Error('name and email are required');
    await api.addUser(draft);
    setDraft(BLANK);
  }, 'Added. Set a password for them below so they can sign in.');

  const savePassword = (id: string) => run(async () => {
    if (pw.length < 12) throw new Error('password must be at least 12 characters');
    await api.setPassword(id, pw);
    setPw(''); setPwFor(null);
  }, 'Password set. Pass it to them through something other than email.');

  return (
    <div className="team">
      <div className="section">People</div>

      {!isAdmin && (
        <p className="team-note">
          Only an admin can add people or change what they can do. You can see the team here.
        </p>
      )}

      <table className="team-table">
        <thead>
          <tr><th>Name</th><th>Email</th><th>Role</th><th>Signs in</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const self = u.id === me?.id;
            const off = !!u.disabled_at;
            return (
              <tr key={u.id} className={off ? 'off' : undefined}>
                <td>{u.name}{self && <i className="team-you">you</i>}</td>
                <td className="team-mail">{u.email}</td>
                <td>
                  {isAdmin && !self ? (
                    <select value={u.role} disabled={busy}
                            onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }), 'Role changed.')}>
                      {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  ) : (
                    <span className="team-role">{ROLES.find((r) => r.id === u.role)?.label ?? u.role}</span>
                  )}
                </td>
                <td className="team-state">
                  {off ? 'Disabled' : u.password_set_at ? 'Yes' : 'No password yet'}
                </td>
                <td className="team-acts">
                  {isAdmin && (
                    <>
                      <button onClick={() => { setPwFor(pwFor === u.id ? null : u.id); setPw(''); }}>
                        {u.password_set_at ? 'Reset password' : 'Set password'}
                      </button>
                      {!self && (
                        <button className="danger" disabled={busy}
                                onClick={() => run(() => api.updateUser(u.id, { disabled: !off }),
                                                   off ? 'Access restored.' : 'Access removed.')}>
                          {off ? 'Enable' : 'Disable'}
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {pwFor && (
        <div className="team-pw">
          <span className="label">
            Password for {users.find((u) => u.id === pwFor)?.name}
            <i> · at least 12 characters · this ends their current sessions</i>
          </span>
          <div className="team-pw-row">
            <input type="password" value={pw} autoComplete="new-password"
                   onChange={(e) => setPw(e.target.value)} placeholder="new password" />
            <button className="btn-primary" disabled={busy} onClick={() => savePassword(pwFor)}>Set</button>
            <button className="btn-ghost" onClick={() => { setPwFor(null); setPw(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {isAdmin && (
        <>
          <div className="section">Add someone</div>
          <div className="team-add">
            <input value={draft.name} placeholder="Full name"
                   onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input value={draft.email} placeholder="name@company.com" type="email"
                   onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            <select value={draft.role}
                    onChange={(e) => setDraft({ ...draft, role: e.target.value as 'sales' })}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button className="btn-primary" disabled={busy} onClick={add}>Add</button>
          </div>
          <dl className="team-roles">
            {ROLES.map((r) => (
              <div key={r.id}><dt>{r.label}</dt><dd>{r.can}</dd></div>
            ))}
          </dl>
        </>
      )}

      {error && <p className="team-err">{error}</p>}
      {note && !error && <p className="team-ok">{note}</p>}
    </div>
  );
}
