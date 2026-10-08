import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONTACT_DEFAULTS, FIELDS, FIELD_GROUPS, KIND, ROUTES, TO_TICKET, ago, flowsApi, labelsOf, withIds, type Flow, type SimResult, type Step } from './flows-api';
import { FlowMap } from './FlowMap';
import { BotSetup } from './BotSetup';

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

type View = 'steps' | 'map' | 'setup';

export function FlowBuilder(
  { slug, accent, view, onView }:
  { slug: string; accent: string; view: View; onView: (v: View) => void },
) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [sel, setSel] = useState(0);
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
      // Branch targets are ids, so nothing can be pointed anywhere until every question has
      // one. Seeding publishedSteps from the same array keeps a flow that merely gained ids
      // from looking like an unpublished edit.
      const steps = withIds(f.steps);
      setFlow(f);
      setSteps(steps);
      setVersion(f.version);
      setPublishedAt(f.published_at);
      setPublishedSteps(JSON.stringify(steps));
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
      const step: Step = { kind: 'ask', id: crypto.randomUUID(), prompt: 'New question', field: 'notes', chips: '', skippable: true };
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
        ...missing.map((d): Step => ({ kind: 'ask', id: crypto.randomUUID(), prompt: d.prompt, field: d.field, chips: '', skippable: !!d.skippable })));
      return next;
    });
  }

  /**
   * Drag to reorder.
   *
   * Safe because a branch names its target by ask id, not by position — a question keeps
   * every route pointing at it when it moves, and keeps its own. Reordering in most builders
   * silently reroutes branches; here it cannot. The arrow buttons stay for keyboard users
   * and for anyone who finds a five-pixel drop zone unkind.
   */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function reorder(from: number, to: number) {
    setSteps((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);   // move, not swap: dragging past two rows should pass both
      setSel(to);
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

  /** Every question a quick reply could jump to, numbered as the list shows them. */
  const targets = useMemo(
    () => steps.flatMap((s, i) => (isAsk(s) ? [{ id: s.id!, n: steps.slice(0, i).filter(isAsk).length + 1, prompt: s.prompt }] : [])),
    [steps]);

  /** Point one answer somewhere, or back at the default by clearing it. */
  const setEdge = useCallback((label: string, to: string) => {
    setSteps((prev) => prev.map((s, i) => {
      if (i !== sel || s.kind !== 'ask') return s;
      const next = { ...(s.next ?? {}) };
      if (to) next[label] = to; else delete next[label];
      // Drop the key entirely when nothing is pinned, so an untouched flow stays byte-identical
      // to what it was before branching existed and does not read as an unpublished edit.
      return Object.keys(next).length ? { ...s, next } : (({ next: _drop, ...rest }) => rest)(s) as Step;
    }));
  }, [sel]);

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
          <button data-on={view === 'steps'} onClick={() => onView('steps')}>Steps</button>
          <button data-on={view === 'map'} onClick={() => onView('map')}>Map</button>
          <button data-on={view === 'setup'} onClick={() => onView('setup')}>Setup</button>
        </span>
        <span className="fb-save">
          {view === 'setup' ? '' : saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Draft saved' : ''}
        </span>
        {/* Publish is about the questions. On Setup it would imply the wording there is also
            waiting to be published, when that saves and applies on its own. */}
        {view !== 'setup' && (
          <button className={`fb-publish${dirty ? ' dirty' : ''}`} onClick={publish} disabled={!dirty}>
            {dirty ? 'Publish changes' : 'Published'}
          </button>
        )}
      </header>

      {view === 'setup' ? (
        <BotSetup flow={flow} onChange={setFlow} />
      ) : view === 'map' ? (
        <FlowMap steps={steps} accent={accent} loops={new Set(sim?.loops ?? [])}
                 onPick={(i) => { setSel(i); onView('steps'); }} />
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
                   draggable
                   onDragStart={(e) => {
                     // The index rides on the drag itself, not only in React state: the
                     // drop handler is a closure from the render that was current when the
                     // drag began, and nothing guarantees a re-render lands between
                     // dragstart and drop. State here is for the visuals; this is the truth.
                     e.dataTransfer.setData('text/plain', String(i));
                     e.dataTransfer.effectAllowed = 'move';
                     setDragFrom(i);
                   }}
                   onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== i) setDragOver(i); }}
                   onDragLeave={() => { if (dragOver === i) setDragOver(null); }}
                   onDrop={(e) => {
                     e.preventDefault();
                     const carried = Number(e.dataTransfer.getData('text/plain'));
                     const from = Number.isInteger(carried) ? carried : dragFrom;
                     if (from !== null && from >= 0) reorder(from, i);
                     setDragFrom(null); setDragOver(null);
                   }}
                   onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
                   data-drag={dragFrom === i ? 'from' : dragOver === i && dragFrom !== null ? 'over' : undefined}
                   style={{ borderColor: on ? 'var(--ink)' : 'var(--line)', borderLeftColor: on ? k.color : 'var(--line)' }}
                   onClick={() => setSel(i)}>
                <div className="fb-card-top">
                  <span className="fb-grip" title="Drag to reorder" aria-hidden="true">⠿</span>
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

                  {/* Always shown, chips or not. A question answered by typing has no chip
                      to hang a route on, so without the "Anything else" row below it could
                      only ever lead to the question after it. */}
                  <div className="fb-field">
                    <span className="label">
                      Where the answer goes
                      {labelsOf(current).length > 0
                        ? <i> · a quick reply with its own route wins</i>
                        : <i> · this question is answered by typing</i>}
                    </span>
                    <div className="fb-edges">
                      {labelsOf(current).map((label) => (
                        <div key={label} className="fb-edge">
                          <span className="fb-edge-chip">{label}</span>
                          <span className="fb-edge-arrow">→</span>
                          <select value={current.next?.[label] ?? ''}
                                  onChange={(e) => setEdge(label, e.target.value)}>
                            <option value="">Follow "anything else"</option>
                            {targets.filter((t) => t.id !== current.id).map((t) => (
                              <option key={t.id} value={t.id}>
                                {String(t.n).padStart(2, '0')} · {t.prompt.length > 42 ? t.prompt.slice(0, 42) + '…' : t.prompt}
                              </option>
                            ))}
                            <option value={TO_TICKET}>Create the ticket and finish</option>
                          </select>
                        </div>
                      ))}
                      <div className="fb-edge fb-edge-default">
                        <span className="fb-edge-chip">Anything else</span>
                        <span className="fb-edge-arrow">→</span>
                        <select value={current.otherwise ?? ''}
                                onChange={(e) => update({ otherwise: e.target.value || undefined })}>
                          <option value="">Next question in order</option>
                          {targets.filter((t) => t.id !== current.id).map((t) => (
                            <option key={t.id} value={t.id}>
                              {String(t.n).padStart(2, '0')} · {t.prompt.length > 42 ? t.prompt.slice(0, 42) + '…' : t.prompt}
                            </option>
                          ))}
                          <option value={TO_TICKET}>Create the ticket and finish</option>
                        </select>
                      </div>
                    </div>
                  </div>
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
