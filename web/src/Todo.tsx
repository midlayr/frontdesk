import { useEffect, useMemo, useState } from 'react';
import { api, userId, type Task } from './api';

/**
 * Everything outstanding, across the shop.
 *
 * Two people need this and they want opposite things from it. A rep wants their own list,
 * shortest possible, and to tick things off without losing their place. An admin wants to
 * see the whole shop and who is carrying what — and, more to the point, what nobody is
 * carrying at all, because an unassigned task is the one that does not get done.
 *
 * So: one page, one filter. It opens on Mine, which is the right answer for six of the
 * seven people who will use it, and Everyone is one click away rather than a separate
 * screen with its own permissions.
 *
 * Deliberately not a kanban or a calendar. These are errands attached to jobs; the useful
 * questions are whose it is and which ticket, and both are columns.
 */

type Row = Task & { ticket_no: string; customer: string; lead_id: string; assignee_name: string | null };
type Sort = 'due' | 'who' | 'ticket';

const ago = (iso: string) => {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
};

/** Overdue, today, or the date — the only thing about a due date anyone reads. */
function due(iso: string | null): { text: string; late: boolean } {
  if (!iso) return { text: '', late: false };
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, late: true };
  if (days === 0) return { text: 'today', late: true };
  if (days === 1) return { text: 'tomorrow', late: false };
  return { text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), late: false };
}

export function Todo({ go }: { go: (to: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [mine, setMine] = useState(true);
  const [sort, setSort] = useState<Sort>('due');
  const [err, setErr] = useState('');

  const load = () => api.allTasks()
    .then((r) => setRows(r.tasks as Row[]))
    .catch((e) => setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e)));
  useEffect(() => { load(); }, []);

  async function toggle(t: Row) {
    const done = !t.done_at;
    // Applied here first and rolled back on failure: a tick that waits on the network
    // feels broken, and this is a page you work down at speed.
    setRows((p) => p && p.map((r) => (r.id === t.id ? { ...r, done_at: done ? new Date().toISOString() : null } : r)));
    try { await api.setTaskDone(t.lead_id, t.id, done); }
    catch { setRows((p) => p && p.map((r) => (r.id === t.id ? t : r))); }
  }

  const shown = useMemo(() => {
    if (!rows) return [];
    const list = mine ? rows.filter((r) => r.assignee_id === userId) : rows;
    const by = {
      // Unassigned sorts to the top of the shop view: a task nobody owns is the one that
      // quietly never happens, so it should be the first thing an admin sees.
      who: (a: Row, b: Row) => (a.assignee_name ?? '').localeCompare(b.assignee_name ?? ''),
      ticket: (a: Row, b: Row) => a.ticket_no.localeCompare(b.ticket_no),
      due: (a: Row, b: Row) =>
        (a.due_at ? Date.parse(a.due_at) : Number.MAX_SAFE_INTEGER)
        - (b.due_at ? Date.parse(b.due_at) : Number.MAX_SAFE_INTEGER),
    }[sort];
    // Done always sinks, whatever the sort — the list is about what is left.
    return [...list].sort((a, b) => Number(!!a.done_at) - Number(!!b.done_at) || by(a, b));
  }, [rows, mine, sort]);

  const open = shown.filter((r) => !r.done_at).length;
  const unowned = (rows ?? []).filter((r) => !r.done_at && !r.assignee_id).length;

  return (
    <div className="fb">
      <header className="fb-head">
        <div>
          <span className="label">To do</span>
          <h2 className="fb-name">{open} outstanding</h2>
        </div>
        <span className="fb-view">
          <button data-on={mine} onClick={() => setMine(true)}>Mine</button>
          <button data-on={!mine} onClick={() => setMine(false)}>Everyone</button>
        </span>
        <span className="fb-view">
          <button data-on={sort === 'due'} onClick={() => setSort('due')}>Due</button>
          <button data-on={sort === 'who'} onClick={() => setSort('who')}>Person</button>
          <button data-on={sort === 'ticket'} onClick={() => setSort('ticket')}>Ticket</button>
        </span>
      </header>

      <div className="set-scroll">
        {err && <p className="team-err">{err}</p>}
        {!rows && !err && <p className="team-note">Loading…</p>}

        {rows && !shown.length && (
          <p className="team-note">
            {mine ? 'Nothing assigned to you.' : 'Nothing outstanding anywhere.'}
            {mine && rows.length > 0 && <> <button className="flow-open" onClick={() => setMine(false)}>
              See everyone's
            </button></>}
          </p>
        )}

        {!mine && unowned > 0 && (
          <p className="setup-warn">
            {unowned} {unowned === 1 ? 'task has' : 'tasks have'} nobody on {unowned === 1 ? 'it' : 'them'} —
            assign the ticket and {unowned === 1 ? 'it' : 'they'} will follow.
          </p>
        )}

        {shown.length > 0 && (
          <table className="todo">
            <thead>
              <tr>
                <th aria-label="Done" />
                <th>Task</th><th>Who</th><th>Ticket</th><th>Due</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const d = due(t.due_at);
                return (
                  <tr key={t.id} data-done={!!t.done_at}>
                    <td>
                      <input type="checkbox" checked={!!t.done_at}
                             aria-label={`Mark "${t.text}" done`}
                             onChange={() => void toggle(t)} />
                    </td>
                    <td className="todo-text">
                      {t.text}
                      {t.source.startsWith('sequence:') && <span className="task-src">campaign</span>}
                      {t.done_at && <span className="todo-when">done {ago(t.done_at)}</span>}
                    </td>
                    <td className={t.assignee_name ? '' : 'todo-nobody'}>
                      {t.assignee_name ?? 'Nobody'}
                    </td>
                    <td>
                      {/* Straight to the job, because the task rarely makes sense without it. */}
                      <button className="flow-open" onClick={() => go(`/?lead=${t.lead_id}`)}>
                        {t.ticket_no}
                      </button>
                      {t.customer && <div className="todo-cust">{t.customer}</div>}
                    </td>
                    <td className={d.late ? 'todo-late' : ''}>{d.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
