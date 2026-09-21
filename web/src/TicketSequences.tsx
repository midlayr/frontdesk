import { useCallback, useEffect, useRef, useState } from 'react';
import { orgSlug } from './api';
import { STATE_COLOR, STATE_LABEL, campaigns, when, type Sequence } from './campaigns-api';

/**
 * Campaign control in the ticket header (wireframe 1f, relocated).
 *
 * It began as a card below the message thread, which put an action a rep takes behind about
 * two screens of scrolling — findable only if you already knew it was there. It belongs
 * beside Status and Assign, because it is the same kind of thing: a state of this ticket
 * that a rep sets, and one they need to see without going looking.
 *
 * Only campaigns a rep can legitimately start by hand are offered. An automatic one enrols
 * on its own, so listing it would invite someone to start a second run and be refused by a
 * database constraint.
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(url(`/api/leads/${leadId}/enrollments`), { headers: headers() });
    if (r.ok) setRows(((await r.json()) as { enrollments: Row[] }).enrollments);
  }, [leadId]);

  useEffect(() => { setOpen(false); load().catch(() => {}); }, [load]);
  useEffect(() => {
    campaigns.list().then(setAll).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  // Click-away and Escape, so the panel behaves like every other menu in the app.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const running = rows.filter((r) => ['active', 'held', 'paused'].includes(r.state));
  const onIds = new Set(running.map((r) => r.sequence_id));
  const offerable = all.filter((s) => s.active && s.trigger === 'manual' && !onIds.has(s.id));
  const lead = running[0];

  async function enroll(sequenceId: string) {
    setBusy(true); setError('');
    try {
      const r = await fetch(url(`/api/leads/${leadId}/enroll`), {
        method: 'POST', headers: headers(), body: JSON.stringify({ sequence_id: sequenceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string; reason?: string }).error ?? (j as { reason?: string }).reason ?? `${r.status}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function setState(seqId: string, id: string, state: string) {
    setBusy(true); setError('');
    try {
      await fetch(url(`/api/sequences/${seqId}/enrollments`), {
        method: 'PATCH', headers: headers(), body: JSON.stringify({ ids: [id], state }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Only disabled once we actually know there is nothing — disabling while the campaign
  // list is still in flight makes the control look permanently unavailable, which is the
  // first thing a rep would conclude and the last thing they would re-check.
  const nothingToOffer = loaded && !running.length && !offerable.length;

  return (
    <div className="tseq-wrap" ref={box}>
      <button className="pick tseq-btn" onClick={() => setOpen(!open)} disabled={nothingToOffer}
              title={nothingToOffer ? 'No campaign is switched on that a rep can start by hand' : undefined}>
        {lead
          ? <>
              <i className="dot" style={{ background: STATE_COLOR[lead.state] }} />
              <span className="tseq-name">{lead.name}</span>
              <span className="tseq-step">{lead.next_step}/{lead.steps}</span>
            </>
          : <><span className="label">Campaign</span>
             <span className="tseq-none-lbl">{loaded ? 'none' : '…'}</span></>}
        <span className="tseq-caret">▾</span>
      </button>

      {open && (
        <div className="tseq-pop">
          {running.map((r) => (
            <div key={r.id} className="tseq-row">
              <span className="tseq-row-top">
                <i className="dot" style={{ background: STATE_COLOR[r.state] }} />
                <b>{r.name}</b>
                <span className="tseq-state">{STATE_LABEL[r.state] ?? r.state}</span>
              </span>
              <span className="tseq-sub">
                step {r.next_step} of {r.steps}
                {r.state === 'active' && ` · next ${when(r.next_send_at)}`}
                {r.state === 'held' && r.held_reason?.startsWith('missing:')
                  && ` · waiting on ${r.held_reason.slice(8)}, fill it in above and it resumes`}
              </span>
              <span className="tseq-acts">
                {r.state === 'paused'
                  ? <button disabled={busy} onClick={() => setState(r.sequence_id, r.id, 'active')}>Resume</button>
                  : <button disabled={busy} onClick={() => setState(r.sequence_id, r.id, 'paused')}>Pause</button>}
                <button className="danger" disabled={busy}
                        onClick={() => setState(r.sequence_id, r.id, 'removed')}>Remove</button>
              </span>
            </div>
          ))}

          {offerable.length > 0 && (
            <>
              <span className="label tseq-add-lbl">{running.length ? 'Also add to' : 'Add to a campaign'}</span>
              {offerable.map((s) => (
                <button key={s.id} className="tseq-offer" disabled={busy} onClick={() => enroll(s.id)}>
                  {s.name} <i>{s.steps} step{s.steps === 1 ? '' : 's'}</i>
                </button>
              ))}
            </>
          )}

          {!running.length && !offerable.length && (
            <p className="tseq-sub">No campaign is switched on that a rep can start by hand.</p>
          )}
          {error && <p className="team-err">{error}</p>}
        </div>
      )}
    </div>
  );
}
