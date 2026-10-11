import { useEffect, useRef, useState } from 'react';
import { ACTIONS, CONDITIONS, campaigns, type Branch } from './campaigns-api';
import { api, type OrgUser } from './api';

/**
 * Branch editor (wireframe 1c) — IF / THEN under a step.
 *
 * The first row is "Replied → Stop sequence" and is not editable or removable. It is a
 * platform rule: a drip that keeps arriving after a customer has answered is the fastest way
 * for a shop to look like it is not listening, and it should not be possible to build one by
 * accident. The server enforces it too; this only shows why the row cannot be touched.
 *
 * Branches are evaluated when the *next* step falls due, which is why the heading says
 * "checked when step N+1 is due" rather than implying they run on send.
 */
/** Long enough to outrun typing, short enough that a dropdown feels immediate. */
const SAVE_DEBOUNCE = 500;

export function Branches({ seqId, stepId, stepCount, position, branches, readOnly, onSaved }: {
  seqId: string; stepId: string; stepCount: number; position: number;
  branches: Branch[]; readOnly: boolean; onSaved: () => void;
}) {
  const withLocked = (b: Branch[]): Branch[] =>
    (b.length ? b : [{ if: 'replied', then: 'stop' }]) as Branch[];

  const [rows, setRows] = useState<Branch[]>(withLocked(branches));
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [error, setError] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => { api.users().then(setUsers).catch(() => {}); }, []);

  /*
   * Resync only when a different step is opened.
   *
   * This used to also depend on `branches`, which made the config inputs impossible to type
   * in. Every keystroke saved, every save called onSaved(), the parent refetched, and the
   * new array came back down and overwrote `rows` — including the characters typed while
   * the request was in flight. You would get a letter or two in and watch the rest vanish.
   *
   * `branches` is a fresh array on every parent render too, so the effect fired constantly
   * rather than only when the branches had genuinely changed.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(withLocked(branches)); }, [stepId]);

  /* Typing is local and immediate; the write is debounced behind it. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function persist(next: Branch[]) {
    setState('saving'); setError('');
    try {
      // Sent without the locked row: the server puts it back, which keeps one authority for
      // the rule rather than two that can drift.
      await campaigns.saveStep(seqId, stepId, { branches: next.slice(1) });
      setState('saved');
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setState('idle'); }
  }

  function save(next: Branch[]) {
    setRows(next);
    if (timer.current) clearTimeout(timer.current);
    setState('saving');
    timer.current = setTimeout(() => void persist(next), SAVE_DEBOUNCE);
  }

  const set = (i: number, patch: Partial<Branch>) =>
    save(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const last = rows.length > 1 ? `step ${Math.min(position + 1, stepCount)}` : `step ${position + 1}`;

  return (
    <div className="br">
      <div className="camp-edit-head">
        <span className="label">
          After step {String(position).padStart(2, '0')}
          <i> · checked when {last} is due</i>
        </span>
        <span className="fb-save">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}</span>
      </div>

      {rows.map((b, i) => {
        const locked = i === 0;
        const action = ACTIONS.find((a) => a.id === b.then);
        const cond = CONDITIONS.find((c) => c.id === b.if);
        return (
          <div key={i} className="br-row" data-locked={locked}>
            <span className="br-if">IF</span>
            <select value={b.if} disabled={locked || readOnly}
                    onChange={(e) => set(i, { if: e.target.value, value: undefined })}>
              {CONDITIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>

            {cond?.needs === 'number' && (
              <input className="br-num" type="number" value={b.value ?? ''} disabled={readOnly}
                     placeholder="40" onChange={(e) => set(i, { value: Number(e.target.value) })} />
            )}

            <span className="br-arrow">→</span>
            <select value={b.then} disabled={locked || readOnly}
                    onChange={(e) => set(i, { then: e.target.value, config: {} })}>
              {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>

            {action?.needs === 'subject' && (
              <input className="br-cfg" value={b.config?.subject ?? ''} disabled={readOnly}
                     placeholder="Still thinking about the {product}?"
                     onChange={(e) => set(i, { config: { ...b.config, subject: e.target.value } })} />
            )}
            {action?.needs === 'step' && (
              <select className="br-cfg" value={b.config?.step ?? ''} disabled={readOnly}
                      onChange={(e) => set(i, { config: { ...b.config, step: Number(e.target.value) } })}>
                <option value="">pick a step</option>
                {Array.from({ length: stepCount }, (_, n) => n + 1)
                  .filter((n) => n !== position)
                  .map((n) => <option key={n} value={n}>step {n}</option>)}
              </select>
            )}
            {action?.needs === 'user' && (
              <select className="br-cfg" value={b.config?.user_id ?? ''} disabled={readOnly}
                      onChange={(e) => set(i, { config: { ...b.config, user_id: e.target.value } })}>
                <option value="">pick somebody</option>
                {users.filter((u) => !u.disabled_at).map((u) => (
                  <option key={u.id} value={u.id}>{u.name || u.email}</option>
                ))}
              </select>
            )}
            {action?.needs === 'text' && (
              <input className="br-cfg" value={b.config?.text ?? ''} disabled={readOnly}
                     placeholder="Ring them about the proof"
                     onChange={(e) => set(i, { config: { ...b.config, text: e.target.value } })} />
            )}
            {action?.needs === 'tag' && (
              <input className="br-cfg" value={b.config?.tag ?? ''} disabled={readOnly}
                     placeholder="warm" onChange={(e) => set(i, { config: { ...b.config, tag: e.target.value } })} />
            )}

            {locked
              ? <span className="br-locked">platform rule</span>
              : !readOnly && (
                  <button className="br-x" title="Remove this branch"
                          onClick={() => save(rows.filter((_, n) => n !== i))}>×</button>
                )}
          </div>
        );
      })}

      {!readOnly && (
        <button className="fb-add" onClick={() => save([...rows, { if: 'not_opened', then: 'continue' }])}>
          + branch
        </button>
      )}
      {error && <p className="team-err">{error}</p>}
    </div>
  );
}
