import { useCallback, useEffect, useState } from 'react';
import { STATE_COLOR, STATE_LABEL, enrollments, when, type Enrollment } from './campaigns-api';

/**
 * Enrolled (wireframe 1d) — who is on this campaign and where they got to.
 *
 * Held rows are the ones that need a person: the drip stopped because a merge token had
 * nothing behind it, and it resumes by itself once a rep fills the field in on the ticket.
 * So the reason is spelled out and the row links straight to the ticket, rather than being
 * a state nobody can act on.
 */
export function Enrolled({ seqId, readOnly, onOpenLead }: {
  seqId: string; readOnly: boolean; onOpenLead: (leadId: string) => void;
}) {
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    enrollments.list(seqId).then(setRows).catch((e) => setError(String(e)));
  }, [seqId]);
  useEffect(() => { load(); setPicked(new Set()); }, [load]);

  const counts = rows.reduce<Record<string, number>>((a, r) => {
    a[r.state] = (a[r.state] ?? 0) + 1; return a;
  }, {});
  const shown = filter ? rows.filter((r) => r.state === filter) : rows;

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  async function bulk(state: 'active' | 'paused' | 'removed') {
    if (!picked.size || busy) return;
    setBusy(true); setError('');
    try {
      await enrollments.bulk(seqId, [...picked], state);
      setPicked(new Set());
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!rows.length) {
    return (
      <div className="enr">
        <p className="camp-empty">
          Nobody is on this campaign yet. Manual campaigns are joined from a ticket —
          open one and use “+ Enroll”.
        </p>
      </div>
    );
  }

  return (
    <div className="enr">
      <div className="enr-filters">
        <button data-on={!filter} onClick={() => setFilter('')}>All {rows.length}</button>
        {Object.entries(counts).map(([state, n]) => (
          <button key={state} data-on={filter === state} onClick={() => setFilter(state)}>
            <i className="dot" style={{ background: STATE_COLOR[state] }} />
            {STATE_LABEL[state] ?? state} {n}
          </button>
        ))}
      </div>

      {picked.size > 0 && !readOnly && (
        <div className="enr-bulk">
          <span>{picked.size} selected</span>
          <button onClick={() => bulk('paused')} disabled={busy}>Pause</button>
          <button onClick={() => bulk('active')} disabled={busy}>Resume</button>
          <button className="danger" onClick={() => bulk('removed')} disabled={busy}>Remove</button>
        </div>
      )}

      <table className="enr-table">
        <thead>
          <tr>
            {!readOnly && <th />}
            <th>Lead</th><th>Step</th><th>Next</th><th>State</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} data-held={r.state === 'held'}>
              {!readOnly && (
                <td className="enr-pick">
                  <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)}
                         aria-label={`Select ${r.ticket_no}`} />
                </td>
              )}
              <td>
                <button className="enr-lead" onClick={() => onOpenLead(r.lead_id)}>
                  {r.who ?? 'Anonymous'} <i>{r.ticket_no}</i>
                </button>
              </td>
              <td className="enr-mono">{r.next_step} of {r.steps}</td>
              <td className="enr-mono">{r.state === 'active' ? when(r.next_send_at) : '—'}</td>
              <td>
                <span className="enr-state" style={{ color: STATE_COLOR[r.state] }}>
                  {STATE_LABEL[r.state] ?? r.state}
                </span>
                {r.state === 'held' && r.held_reason && (
                  <span className="enr-why">
                    {r.held_reason.startsWith('missing:')
                      ? `no ${r.held_reason.slice(8)}`
                      : r.held_reason}
                    {' · '}
                    <button className="enr-fix" onClick={() => onOpenLead(r.lead_id)}>fix on ticket →</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="team-err">{error}</p>}
    </div>
  );
}
