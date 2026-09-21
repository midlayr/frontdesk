import { useEffect, useState } from 'react';
import { stats, type StatRow } from './campaigns-api';

/**
 * Performance (wireframe 1e) — is this campaign worth keeping?
 *
 * Percentages are shown only where the denominator is big enough to mean anything. "100%
 * open rate" on two sends is not a fact about the campaign, and a shop that drops a step
 * because of it has been misled by its own dashboard.
 */

const SPANS = [{ id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }, { id: 'all', label: 'All' }];
const ENOUGH = 5;

const money = (v: string) =>
  Number(v) ? `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';

export function Performance({ seqId }: { seqId: string }) {
  const [span, setSpan] = useState('30d');
  const [data, setData] = useState<Awaited<ReturnType<typeof stats.get>> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    stats.get(seqId, span).then(setData).catch((e) => setError(String(e)));
  }, [seqId, span]);

  const total: StatRow | undefined = data?.stats.find((s) => !s.step_id);
  const byStep = new Map((data?.stats ?? []).filter((s) => s.step_id).map((s) => [s.step_id!, s]));

  const pct = (n: number, d: number) => (d >= ENOUGH ? `${Math.round((n / d) * 100)}%` : '—');

  return (
    <div className="perf">
      <div className="perf-head">
        <span className="label">Performance</span>
        <span className="fb-view">
          {SPANS.map((s) => (
            <button key={s.id} data-on={span === s.id} onClick={() => setSpan(s.id)}>{s.label}</button>
          ))}
        </span>
      </div>

      {!data && !error && <p className="camp-empty">Working it out…</p>}
      {error && <p className="team-err">{error}</p>}

      {data && total && (
        <>
          <div className="perf-cells">
            <Cell label="Enrolled" value={String(total.enrolled)} />
            <Cell label="Replied" value={String(total.replied)}
                  note={pct(total.replied, total.enrolled)} />
            <Cell label="Won after" value={String(total.won)}
                  note={total.won ? 'within 30 days of a send' : undefined} />
            <Cell label="Revenue" value={money(total.revenue)} />
          </div>

          {total.enrolled === 0 && (
            <p className="camp-empty">
              Nothing has run yet, so there is nothing to judge. The numbers fill in once
              people are enrolled and steps have gone out.
            </p>
          )}

          {data.steps.length > 0 && total.sent > 0 && (
            <>
              <span className="label">By step</span>
              <div className="perf-steps">
                {data.steps.map((st) => {
                  const s = byStep.get(st.id);
                  const sent = s?.sent ?? 0;
                  const open = sent ? (s!.opened / sent) * 100 : 0;
                  return (
                    <div key={st.id} className="perf-step">
                      <span className="perf-step-name">
                        {String(st.position).padStart(2, '0')} · {st.subject || st.kind}
                      </span>
                      <span className="perf-bar">
                        <i style={{ width: `${Math.min(open, 100)}%` }} />
                      </span>
                      <span className="perf-step-num">
                        {sent < ENOUGH
                          ? `${sent} sent`
                          : `${Math.round(open)}% open · ${s!.replied} repl.`}
                      </span>
                    </div>
                  );
                })}
              </div>
              {total.sent < ENOUGH && (
                <p className="camp-hint">
                  Too few sends to read anything into the rates yet — they appear past {ENOUGH}.
                </p>
              )}
            </>
          )}

          {total.read && <p className="perf-read"><b>Read:</b> {total.read}</p>}

          <p className="camp-hint">
            Won after counts a ticket reaching Won within 30 days of a step going out to it.
            Rolled up nightly · last {new Date(total.computed_at).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

function Cell({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="perf-cell">
      <span className="label">{label}</span>
      <b>{value}</b>
      {note && <i>{note}</i>}
    </div>
  );
}
