import { useEffect, useMemo, useState } from 'react';
import { api, userId, type OrgUser, type Task } from './api';

/**
 * Everything outstanding, across the shop.
 *
 * Two people want opposite things from this page. A rep wants their own list, short, with
 * the late things first, and to tick them off without losing their place. An admin wants
 * the shop: who is carrying what, and — the thing a per-person view can never show — what
 * nobody is carrying at all.
 *
 * So it is one page with one filter, and the admin view GROUPS by person rather than
 * repeating a name down a column. A list of thirty rows with "Sean Wheelock" written
 * eleven times does not answer "how is Sean doing"; a heading saying Sean · 11, 3 late
 * does.
 *
 * Reassigning happens here too. The commonest thing an admin does on seeing a task with
 * nobody on it is give it to somebody, and making them open the ticket to do that is the
 * difference between a list you work and a list you read.
 */

type Row = Task & {
  ticket_no: string; customer: string; lead_id: string; assignee_name: string | null;
};
type Group = 'due' | 'who' | 'ticket';

const NOBODY = '\u0000nobody';   // sorts first, and cannot collide with a real id

function due(iso: string | null): { text: string; late: boolean; sort: number } {
  if (!iso) return { text: '', late: false, sort: Number.MAX_SAFE_INTEGER };
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  const text = days < 0 ? `${Math.abs(days)}d overdue`
    : days === 0 ? 'today' : days === 1 ? 'tomorrow'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { text, late: days <= 0, sort: d.getTime() };
}

const ago = (iso: string) => {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
};

export function Todo({ go }: { go: (to: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [mine, setMine] = useState(true);
  const [group, setGroup] = useState<Group>('due');
  const [showDone, setShowDone] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.allTasks().then((r) => setRows(r.tasks as Row[]))
      .catch((e) => setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e)));
    api.users().then(setUsers).catch(() => {});
  }, []);

  /** Applied here first and rolled back on failure — this is a list you work down at speed. */
  const patch = async (t: Row, change: Partial<Row>, send: () => Promise<unknown>) => {
    setRows((p) => p && p.map((r) => (r.id === t.id ? { ...r, ...change } : r)));
    try { await send(); } catch { setRows((p) => p && p.map((r) => (r.id === t.id ? t : r))); }
  };

  const toggle = (t: Row) => patch(t,
    { done_at: t.done_at ? null : new Date().toISOString() },
    () => api.setTaskDone(t.lead_id, t.id, !t.done_at));

  const reassign = (t: Row, id: string) => patch(t,
    { assignee_id: id || null, assignee_name: users.find((u) => u.id === id)?.name ?? null },
    () => api.setTaskAssignee(t.lead_id, t.id, id || null));

  const visible = useMemo(() => {
    if (!rows) return [];
    const list = mine ? rows.filter((r) => r.assignee_id === userId) : rows;
    return showDone ? list : list.filter((r) => !r.done_at);
  }, [rows, mine, showDone]);

  /** Grouped only where a heading earns its place — by due date it is one ordered list. */
  const groups = useMemo(() => {
    const byDue = (a: Row, b: Row) => due(a.due_at).sort - due(b.due_at).sort;
    const sunk = (a: Row, b: Row) => Number(!!a.done_at) - Number(!!b.done_at);

    if (group === 'due') {
      return [{ key: 'all', title: '', count: 0, late: 0,
                rows: [...visible].sort((a, b) => sunk(a, b) || byDue(a, b)) }];
    }

    const map = new Map<string, Row[]>();
    for (const r of visible) {
      const k = group === 'who' ? (r.assignee_id ?? NOBODY) : r.ticket_no;
      map.set(k, [...(map.get(k) ?? []), r]);
    }
    const name = (k: string, rs: Row[]) =>
      group === 'who' ? (k === NOBODY ? 'Nobody' : rs[0].assignee_name ?? 'Nobody')
                      : `${k}${rs[0].customer ? ` · ${rs[0].customer}` : ''}`;

    return [...map.entries()]
      // Nobody first when grouped by person: an unowned task is the one that does not
      // happen, so it should be the first thing an admin reads.
      .sort(([a], [b]) => (a === NOBODY ? -1 : b === NOBODY ? 1 : a.localeCompare(b)))
      .map(([k, rs]) => ({
        key: k,
        title: name(k, rs),
        count: rs.filter((r) => !r.done_at).length,
        late: rs.filter((r) => !r.done_at && due(r.due_at).late).length,
        rows: [...rs].sort((a, b) => sunk(a, b) || byDue(a, b)),
      }));
  }, [visible, group]);

  const open = visible.filter((r) => !r.done_at).length;
  const late = visible.filter((r) => !r.done_at && due(r.due_at).late).length;
  const doneCount = (mine ? (rows ?? []).filter((r) => r.assignee_id === userId) : (rows ?? []))
    .filter((r) => r.done_at).length;

  return (
    <div className="fb">
      <header className="fb-head">
        <div>
          <span className="label">To do</span>
          <h2 className="fb-name">
            {open} outstanding
            {late > 0 && <span className="todo-late-count"> · {late} late</span>}
          </h2>
        </div>
        <span className="fb-view">
          <button data-on={mine} onClick={() => setMine(true)}>Mine</button>
          <button data-on={!mine} onClick={() => setMine(false)}>Everyone</button>
        </span>
        <span className="fb-view">
          <button data-on={group === 'due'} onClick={() => setGroup('due')}>By date</button>
          <button data-on={group === 'who'} onClick={() => setGroup('who')}>By person</button>
          <button data-on={group === 'ticket'} onClick={() => setGroup('ticket')}>By ticket</button>
        </span>
        {doneCount > 0 && (
          <button className="fb-restart" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide' : 'Show'} {doneCount} done
          </button>
        )}
      </header>

      <div className="set-scroll">
        {err && <p className="team-err">{err}</p>}
        {!rows && !err && <p className="team-note">Loading…</p>}

        {rows && !visible.length && (
          <p className="team-note">
            {mine ? 'Nothing assigned to you.' : 'Nothing outstanding anywhere.'}
            {mine && rows.some((r) => !r.done_at) && (
              <> <button className="flow-open" onClick={() => setMine(false)}>See everyone's</button></>
            )}
          </p>
        )}

        {groups.map((g) => (
          <div key={g.key} className="qblock">
            {g.title && (
              <div className="qgroup">
                {g.title}
                <span className="todo-grp-n">
                  {' · '}{g.count} open{g.late > 0 && `, ${g.late} late`}
                </span>
              </div>
            )}
            {g.rows.map((t) => {
              const d = due(t.due_at);
              return (
                <div key={t.id} className="todo-row" data-done={!!t.done_at}>
                  {/* The whole line is the target, not a 13px box. */}
                  <label className="todo-tick">
                    <input type="checkbox" checked={!!t.done_at}
                           aria-label={`Mark "${t.text}" done`}
                           onChange={() => void toggle(t)} />
                  </label>

                  <div className="todo-main">
                    <div className="todo-what">
                      {t.text}
                      {t.source.startsWith('sequence:') && <span className="task-src">campaign</span>}
                    </div>
                    <div className="todo-meta">
                      <button className="flow-open" onClick={() => go(`/?lead=${t.lead_id}`)}>
                        {t.ticket_no}
                      </button>
                      {t.customer && <span>{t.customer}</span>}
                      {d.text && <span className={d.late ? 'todo-late' : ''}>{d.text}</span>}
                      {t.done_at && <span>done {ago(t.done_at)}</span>}
                    </div>
                  </div>

                  {/* Hand it over from here: opening the ticket to do this is the
                      difference between a list you work and a list you read. */}
                  <select className="todo-who" value={t.assignee_id ?? ''}
                          aria-label={`Who is doing "${t.text}"`}
                          data-nobody={!t.assignee_id}
                          onChange={(e) => void reassign(t, e.target.value)}>
                    <option value="">Nobody</option>
                    {users.filter((u) => !u.disabled_at).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
