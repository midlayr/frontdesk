import { useCallback, useEffect, useState } from 'react';
import { orgSlug } from './api';
import { STATE_COLOR, STATE_LABEL, TRIGGER_LABEL, campaigns, when, type Sequence } from './campaigns-api';

/**
 * The Sequences card on a ticket (wireframe 1f).
 *
 * Only campaigns a rep can legitimately start by hand are offered. A lead_created or
 * quoted_no_reply campaign enrols on its own; showing it here would invite someone to start
 * a second run of something already running, and the unique index would refuse them with a
 * message about a constraint.
 */

interface Row {
  id: string; state: string; held_reason: string | null; next_send_at: string | null;
  next_step: number; sequence_id: string; name: string; active: boolean; steps: number;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const u = localStorage.getItem('fd_user'); if (u) h['x-dev-user'] = u;
  const t = sessionStorage.getItem('fd_token'); if (t) h['x-admin-token'] = t;
  return h;
}
const url = (p: string) => `${p}${p.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;

export function TicketSequences({ leadId }: { leadId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [all, setAll] = useState<Sequence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(url(`/api/leads/${leadId}/enrollments`), { headers: headers() });
    if (r.ok) setRows(((await r.json()) as { enrollments: Row[] }).enrollments);
  }, [leadId]);

  useEffect(() => { setPicking(false); load().catch(() => {}); }, [load]);
  useEffect(() => { campaigns.list().then(setAll).catch(() => {}); }, []);

  const running = rows.filter((r) => ['active', 'held', 'paused'].includes(r.state));
  const onIds = new Set(running.map((r) => r.sequence_id));
  const offerable = all.filter((s) => s.active && s.trigger === 'manual' && !onIds.has(s.id));

  async function act(path: string, body: unknown) {
    setBusy(true); setError('');
    try {
      const r = await fetch(url(path), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string; reason?: string }).error
        ?? (j as { reason?: string }).reason ?? `${r.status}`);
      await load();
      setPicking(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const setState = (seqId: string, id: string, state: string) =>
    fetch(url(`/api/sequences/${seqId}/enrollments`), {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ ids: [id], state }),
    }).then(load).catch((e) => setError(String(e)));

  return (
    <>
      <div className="section">
        Sequences
        {offerable.length > 0 && (
          <button className="hist-toggle" onClick={() => setPicking(!picking)}>
            {picking ? 'cancel' : '+ enroll'}
          </button>
        )}
      </div>

      {picking && (
        <div className="tseq-pick">
          {offerable.map((s) => (
            <button key={s.id} disabled={busy}
                    onClick={() => act(`/api/leads/${leadId}/enroll`, { sequence_id: s.id })}>
              {s.name} <i>{s.steps} step{s.steps === 1 ? '' : 's'}</i>
            </button>
          ))}
        </div>
      )}

      {running.length === 0 && !picking && (
        <p className="tseq-none">
          {offerable.length
            ? 'Not on a campaign.'
            : 'No campaign is switched on that a rep can start by hand.'}
        </p>
      )}

      {rows.filter((r) => r.state !== 'removed').map((r) => (
        <div key={r.id} className="tseq">
          <span className="tseq-top">
            <i className="dot" style={{ background: STATE_COLOR[r.state] }} />
            <b>{r.name}</b>
            <span className="tseq-state">{STATE_LABEL[r.state] ?? r.state}</span>
          </span>
          <span className="tseq-sub">
            step {r.next_step} of {r.steps}
            {r.state === 'active' && ` · next ${when(r.next_send_at)}`}
            {r.state === 'held' && r.held_reason?.startsWith('missing:')
              && ` · waiting on ${r.held_reason.slice(8)} — fill it in above and it resumes`}
          </span>
          {['active', 'held', 'paused'].includes(r.state) && (
            <span className="tseq-acts">
              {r.state === 'paused'
                ? <button onClick={() => setState(r.sequence_id, r.id, 'active')}>Resume</button>
                : <button onClick={() => setState(r.sequence_id, r.id, 'paused')}>Pause</button>}
              <button className="danger" onClick={() => setState(r.sequence_id, r.id, 'removed')}>
                Remove
              </button>
            </span>
          )}
        </div>
      ))}

      {error && <p className="team-err">{error}</p>}
    </>
  );
}

export { TRIGGER_LABEL };
