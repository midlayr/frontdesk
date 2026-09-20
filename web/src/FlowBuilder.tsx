import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONTACT_DEFAULTS, FIELDS, FIELD_GROUPS, KIND, ROUTES, ago, flowsApi, type Flow, type SimResult, type Step } from './flows-api';
import { FlowMap } from './FlowMap';

const SAVE_DEBOUNCE = 500;

const isAsk = (s: Step): s is Extract<Step, { kind: 'ask' }> => s.kind === 'ask';

function subline(s: Step): string {
  if (s.kind === 'ask') {
    const chips = s.chips?.split(',').filter((c) => c.trim()).length ?? 0;
    return `→ ${FIELDS[s.field] ?? s.field}${chips ? ` · ${chips} quick replies` : ' · free text'}`;
  }
  if (s.kind === 'rule') return `when: ${s.words || '—'}`;
  return 'ends the flow';
}

const titleOf = (s: Step) =>
  s.kind === 'ask' ? s.prompt : s.kind === 'rule' ? 'Hand off to a rep' : 'Create job ticket';

export function FlowBuilder({ slug, accent }: { slug: string; accent: string }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<'steps' | 'map'>('steps');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [publishedSteps, setPublishedSteps] = useState<string>('');
  const [version, setVersion] = useState(0);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [error, setError] = useState('');

  // preview
  const [said, setSaid] = useState<string[]>([]);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  const dirty = publishedSteps !== '' && JSON.stringify(steps) !== publishedSteps;

  useEffect(() => {
    flowsApi.get(slug).then((f) => {
      setFlow(f);
      setSteps(f.steps);
      setVersion(f.version);
      setPublishedAt(f.published_at);
      setPublishedSteps(JSON.stringify(f.steps));
    }).catch((e) => setError(String(e)));
  }, [slug]);

  // autosave the draft, debounced
  const first = useRef(true);
  useEffect(() => {
    if (!flow || !steps.length) return;
    if (first.current) { first.current = false; return; }
    setSaving('saving');
    const t = setTimeout(() => {
      flowsApi.save(slug, flow.name, steps)
        .then(() => setSaving('saved'))
        .catch((e) => { setError(String(e)); setSaving('idle'); });
    }, SAVE_DEBOUNCE);
    return () => clearTimeout(t);
  }, [steps, slug, flow]);

  // the preview always runs the steps on screen, not the saved ones
  useEffect(() => {
    if (!steps.length) return;
    let cancelled = false;
    flowsApi.simulate(slug, steps, said)
      .then((r) => { if (!cancelled) setSim(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [steps, said, slug]);

  useEffect(() => { threadRef.current?.scrollTo(0, threadRef.current.scrollHeight); }, [sim]);

  const update = useCallback((patch: Partial<Step>) => {
    setSteps((prev) => prev.map((s, i) => (i === sel ? ({ ...s, ...patch } as Step) : s)));
  }, [sel]);

  function addQuestion() {
    setSteps((prev) => {
      const at = prev.findIndex((s) => s.kind !== 'ask');
      const step: Step = { kind: 'ask', prompt: 'New question', field: 'notes', chips: '', skippable: true };
      const next = [...prev];
      next.splice(at < 0 ? next.length : at, 0, step);
      setSel(at < 0 ? next.length - 1 : at);
      return next;
    });
  }

  /** Append the standard contact questions, skipping any the flow already asks for. */
  function addContactSet() {
    setSteps((prev) => {
      const have = new Set(prev.filter(isAsk).map((s) => s.field));
      const missing = CONTACT_DEFAULTS.filter((d) => !have.has(d.field));
      if (!missing.length) return prev;
      const at = prev.findIndex((s) => s.kind !== 'ask');
      const next = [...prev];
      next.splice(at < 0 ? next.length : at, 0,
        ...missing.map((d): Step => ({ kind: 'ask', prompt: d.prompt, field: d.field, chips: '', skippable: !!d.skippable })));
      return next;
    });
  }

  function move(dir: -1 | 1) {
    setSteps((prev) => {
      const to = sel + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[sel], next[to]] = [next[to], next[sel]];
      setSel(to);
      return next;
    });
  }

  function remove(i: number) {
    setSteps((prev) => {
      if (!isAsk(prev[i]) || prev.filter(isAsk).length <= 1) return prev;
      const next = prev.filter((_, n) => n !== i);
      setSel(Math.min(i, next.length - 1));
      return next;
    });
  }

  async function publish() {
    try {
      const r = await flowsApi.publish(slug);
      setVersion(r.version);
      setPublishedAt(new Date().toISOString());
      setPublishedSteps(JSON.stringify(steps));
    } catch (e) { setError(String(e)); }
  }

  const current = steps[sel];
  const askCount = useMemo(() => steps.filter(isAsk).length, [steps]);

  if (!flow) return <div className="fb-empty">{error || 'Loading flow…'}</div>;

  return (
    <div className="fb">
      <header className="fb-head">
        <div>
          <span className="label">Flow</span>
          <h2 className="fb-name">{flow.name}</h2>
        </div>
        <span className="fb-ver">v{version} · published {ago(publishedAt)}</span>
        <span className="fb-view">
          <button data-on={view === 'steps'} onClick={() => setView('steps')}>Steps</button>
          <button data-on={view === 'map'} onClick={() => setView('map')}>Map</button>
        </span>
        <span className="fb-save">{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Draft saved' : ''}</span>
        <button className={`fb-publish${dirty ? ' dirty' : ''}`} onClick={publish} disabled={!dirty}>
          {dirty ? 'Publish changes' : 'Published'}
        </button>
      </header>

      {view === 'map' ? (
        <FlowMap steps={steps} accent={accent}
                 onPick={(i) => { setSel(i); setView('steps'); }} />
      ) : (
      <div className="fb-grid">
        {/* ── 1 · steps ── */}
        <div className="fb-steps">
          <div className="fb-steps-head">
            <span className="label">Flow · {slug.replace(/-/g, ' ')}</span>
            <span className="label">{askCount} questions</span>
          </div>

          {steps.map((s, i) => {
            const k = KIND[s.kind];
            const on = i === sel;
            return (
              <div key={i} className="fb-card" data-on={on}
                   style={{ borderColor: on ? 'var(--ink)' : 'var(--line)', borderLeftColor: on ? k.color : 'var(--line)' }}
                   onClick={() => setSel(i)}>
                <div className="fb-card-top">
                  <span className="fb-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="fb-kind" style={{ color: k.color }}>{k.label}</span>
                  <span className="fb-ctl">
                    <button title="Move up" disabled={i === 0} onClick={(e) => { e.stopPropagation(); setSel(i); move(-1); }}>↑</button>
                    <button title="Move down" disabled={i === steps.length - 1} onClick={(e) => { e.stopPropagation(); setSel(i); move(1); }}>↓</button>
                    {isAsk(s) && (
                      <button title="Delete" disabled={askCount <= 1} onClick={(e) => { e.stopPropagation(); remove(i); }}>×</button>
                    )}
                  </span>
                </div>
                <div className="fb-title">{titleOf(s)}</div>
                <div className="fb-sub">{subline(s)}</div>
              </div>
            );
          })}

          <button className="fb-add" onClick={addQuestion}>+ Add a question</button>
          <button className="fb-add" onClick={addContactSet} title="Name, company, email and phone">
            + Add contact questions
          </button>
        </div>

        {/* ── 2 · editor ── */}
        <div className="fb-editor">
          {current && (
            <>
              <span className="label">Step {String(sel + 1).padStart(2, '0')} · {KIND[current.kind].label}</span>
              <h3 className="fb-edit-title">
                {current.kind === 'ask' ? 'Ask the visitor'
                  : current.kind === 'rule' ? 'When to bring in a person'
                  : 'Finish and create the ticket'}
              </h3>

              {current.kind === 'ask' && (
                <>
                  <Field label="Prompt">
                    <textarea rows={3} value={current.prompt} onChange={(e) => update({ prompt: e.target.value })} />
                  </Field>
                  <Field label="Saves to ticket field">
                    <select value={current.field} onChange={(e) => update({ field: e.target.value })}>
                      {FIELD_GROUPS.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.fields.map((f) => <option key={f} value={f}>{FIELDS[f]}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                  <Field label="Quick replies" hint="comma separated · shown as chips">
                    <input value={current.chips ?? ''} placeholder="100, 250, 500"
                           onChange={(e) => update({ chips: e.target.value })} />
                  </Field>
                  <label className="fb-check">
                    <input type="checkbox" checked={!!current.skippable}
                           onChange={(e) => update({ skippable: e.target.checked })} />
                    <span>Allow skipping this question</span>
                  </label>
                </>
              )}

              {current.kind === 'rule' && (
                <>
                  <Field label="Keywords" hint="comma separated · matched anywhere in the message">
                    <input value={current.words} onChange={(e) => update({ words: e.target.value })} />
                  </Field>
                  <Field label="Handoff message">
                    <textarea rows={3} value={current.handoff} onChange={(e) => update({ handoff: e.target.value })} />
                  </Field>
                  <Field label="Then">
                    <select value={current.route} onChange={(e) => update({ route: e.target.value })}>
                      {Object.entries(ROUTES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </Field>
                  <label className="fb-check">
                    <input type="checkbox" checked={!!current.afterHours}
                           onChange={(e) => update({ afterHours: e.target.checked })} />
                    <span>Apply outside business hours too</span>
                  </label>
                </>
              )}

              {current.kind === 'ticket' && (
                <Field label="Confirmation">
                  <textarea rows={4} value={current.text} onChange={(e) => update({ text: e.target.value })} />
                </Field>
              )}

              {error && <p className="fb-err">{error}</p>}
            </>
          )}
        </div>

        {/* ── 3 · live preview ── */}
        <div className="fb-preview">
          <div className="fb-prev-head">
            <span className="label">Live preview · unsaved draft</span>
            <button className="fb-restart" onClick={() => { setSaid([]); setDraft(''); }}>Restart</button>
          </div>

          <div className="fb-widget">
            <div className="fb-wbar" style={{ background: 'var(--ink)' }}>
              <span>Dumont Printing</span>
              <span className="fb-wlive" style={{ color: sim?.state === 'live' ? 'var(--ok-bright)' : 'var(--ink-3)' }}>
                {sim?.state === 'live' ? '● waiting for a rep' : '· quotes'}
              </span>
            </div>

            <div className="fb-thread" ref={threadRef}>
              {sim?.turns.map((t, i) => (
                <div key={i} className={`fb-turn ${t.who}`}
                     style={t.who === 'visitor'
                       ? { background: 'var(--accent-tint)', borderColor: accent, alignSelf: 'flex-end' }
                       : undefined}>
                  <span className="fb-who">{t.who === 'visitor' ? 'You' : 'Dumont'}</span>
                  {t.text}
                </div>
              ))}
              {sim?.completed && <div className="fb-made">Ticket created · flow complete</div>}
            </div>

            {!!sim?.chips.length && (
              <div className="fb-chips">
                {sim.chips.map((c) => (
                  <button key={c} style={{ borderColor: accent, color: accent }}
                          onClick={() => setSaid((p) => [...p, c])}>{c}</button>
                ))}
              </div>
            )}

            <form className="fb-compose" onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              setSaid((p) => [...p, draft.trim()]);
              setDraft('');
            }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)}
                     placeholder={sim?.state === 'done' ? 'Flow finished — Restart to try again' : 'Type your answer'} />
              <button type="submit" style={{ background: accent }}>↵</button>
            </form>
          </div>

          {sim && Object.keys(sim.captured).length > 0 && (
            <div className="fb-captured">
              <span className="label">Captured so far</span>
              {Object.entries(sim.captured).map(([k, v]) => (
                <div key={k} className="fb-cap"><span>{FIELDS[k] ?? k}</span><b>{v}</b></div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fb-field">
      <span className="label">{label}{hint && <i> · {hint}</i>}</span>
      {children}
    </div>
  );
}
