import { useCallback, useEffect, useRef, useState } from 'react';
import { Branches } from './Branches';
import { NewSequence } from './NewSequence';
import {
  KINDS, TOKENS, TRIGGER_LABEL, campaigns, hours,
  type Preview, type Sequence, type Step,
} from './campaigns-api';

/**
 * Campaigns · the step editor (wireframe 1b).
 *
 * The preview is the point of this screen. A merge token that resolves to nothing is the
 * failure everyone ships at least once — "Hi ," going to a customer — so the editor renders
 * the step through the same endpoint the send engine uses, against a real lead, and says
 * plainly which tokens have nothing behind them. Unknown tokens block saving rather than
 * being quietly accepted.
 */

const SAVE_DEBOUNCE = 500;

export function Campaigns({ me }: { me: { id: string; role: string } | null }) {
  const [list, setList] = useState<Sequence[]>([]);
  const [seqId, setSeqId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAdmin = me?.role === 'admin';

  const reload = useCallback(() => campaigns.list().then(setList).catch((e) => setError(String(e))), []);
  useEffect(() => { reload(); }, [reload]);

  const open = useCallback(async (id: string) => {
    setSeqId(id);
    const d = await campaigns.get(id);
    setSequence(d.sequence);
    setSteps(d.steps);
    setStepId((prev) => (d.steps.some((s) => s.id === prev) ? prev : d.steps[0]?.id ?? null));
  }, []);

  /**
   * Shown the moment the server confirms it, from the row the create returns.
   *
   * Fetching the sequence again first leaves the list stale for two round trips, which is
   * long enough to click twice, or to delete the step the screen is still showing.
   */
  async function addStep() {
    if (!seqId || busy) return;
    setBusy(true); setError('');
    try {
      const { step } = await campaigns.addStep(seqId);
      setSteps((prev) => [...prev, step]);
      setStepId(step.id);
      reload();                       // the rail's step count, in the background
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function removeStep(step: Step) {
    if (!seqId || busy) return;
    const what = step.subject?.trim() || step.body.split('\n')[0].trim() || 'this empty step';
    if (!confirm(`Delete step ${step.position} — “${what}”?\n\nThe steps after it move up. Anyone part-way through the sequence carries on from wherever they are.`)) return;
    setBusy(true); setError('');
    try {
      await campaigns.deleteStep(seqId, step.id);
      // Gone from the list at once, then reconciled — the server renumbers what is left.
      const order = steps.filter((s) => s.id !== step.id);
      setSteps(order);
      setStepId(order[Math.min(step.position - 1, order.length - 1)]?.id ?? null);
      await open(seqId);
      reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function toggleLive() {
    if (!seqId || !sequence) return;
    try {
      const r = await campaigns.live(seqId, !sequence.active);
      setSequence({ ...sequence, active: r.active });
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const step = steps.find((s) => s.id === stepId) ?? null;

  return (
    <div className="fb">
      {creating && (
        <NewSequence onClose={() => setCreating(false)}
                     onCreated={async (id) => { setCreating(false); await reload(); await open(id); }} />
      )}
      <header className="fb-head">
        <div>
          <span className="label">Campaigns</span>
          <h2 className="fb-name">{sequence?.name ?? 'Campaigns'}</h2>
        </div>
        {sequence && (
          <span className="fb-ver">
            {TRIGGER_LABEL[sequence.trigger] ?? sequence.trigger} · {sequence.channel}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        {sequence && isAdmin && (
          <button className={`fb-publish${sequence.active ? '' : ' dirty'}`} onClick={toggleLive}>
            {sequence.active ? 'Live · switch off' : 'Turn on'}
          </button>
        )}
      </header>

      <div className="camp">
        {/* ── the campaigns, and the steps of the open one ── */}
        <div className="camp-rail">
          <div className="camp-rail-head">
            <span className="label">Campaigns</span>
            {isAdmin && <button className="camp-new" onClick={() => setCreating(true)}>+ New</button>}
          </div>
          {list.map((s) => (
            <button key={s.id} className="camp-item" data-on={s.id === seqId} onClick={() => open(s.id)}>
              <span className="camp-item-top">
                <i className="dot" style={{ background: s.active ? 'var(--ok)' : 'var(--ink-3)' }} />
                {s.name}
              </span>
              <span className="camp-item-sub">
                {s.steps} step{s.steps === 1 ? '' : 's'} · {s.active_count} active
                {s.held_count ? ` · ${s.held_count} held` : ''}
              </span>
            </button>
          ))}
          {!list.length && <p className="camp-empty">No campaigns yet.</p>}

          {sequence && (
            <>
              <div className="camp-rail-head" style={{ marginTop: 18 }}>
                <span className="label">Steps</span>
              </div>
              {steps.map((s) => (
                <button key={s.id} className="camp-step" data-on={s.id === stepId}
                        onClick={() => setStepId(s.id)}>
                  <span className="camp-step-top">
                    <span className="fm-n">{String(s.position).padStart(2, '0')}</span>
                    <span className="camp-kind">{s.kind.toUpperCase()}</span>
                    <span className="camp-when">{hours(s.delay_hours)}</span>
                  </span>
                  <span className="camp-step-title">
                    {s.kind === 'email' ? (s.subject || 'No subject yet')
                      : (s.body.split('\n')[0] || 'Empty')}
                  </span>
                </button>
              ))}
              {isAdmin && (
                <button className="fb-add" onClick={addStep} disabled={busy}>
                  {busy ? 'Working…' : '+ Add a step'}
                </button>
              )}
            </>
          )}
        </div>

        {step && seqId
          ? <StepEditor key={step.id} seqId={seqId} step={step} readOnly={!isAdmin}
                        stepCount={steps.length} onSaved={() => open(seqId)}
                        onDelete={() => removeStep(step)} />
          : <div className="fb-empty">{error || 'Pick a campaign, then a step.'}</div>}
      </div>
    </div>
  );
}

function StepEditor({ seqId, step, stepCount, readOnly, onSaved, onDelete }: {
  seqId: string; step: Step; stepCount: number; readOnly: boolean;
  onSaved: () => void; onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Step>(step);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // A token the engine does not know would be sent literally, so it blocks the save rather
  // than being written and discovered by a customer.
  const used = [...draft.body.matchAll(/\{(\w+)\}/g), ...(draft.subject ?? '').matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1]);
  const unknown = [...new Set(used.filter((t) => !(TOKENS as readonly string[]).includes(t)))];

  // Compared against the step as loaded rather than gated on a "first render" flag: under
  // StrictMode the effect runs twice on mount, which spent the flag and then saved an
  // untouched step on arrival.
  const dirty = draft.kind !== step.kind || draft.subject !== step.subject
    || draft.body !== step.body || draft.attach_quote !== step.attach_quote
    || draft.delay_hours !== step.delay_hours;

  useEffect(() => {
    if (!dirty || readOnly || unknown.length) return;
    setSaving('saving');
    const t = setTimeout(() => {
      campaigns.saveStep(seqId, step.id, {
        kind: draft.kind, subject: draft.subject, body: draft.body,
        attach_quote: draft.attach_quote, delay_hours: draft.delay_hours,
      }).then(() => { setSaving('saved'); onSaved(); })
        .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setSaving('idle'); });
    }, SAVE_DEBOUNCE);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind, draft.subject, draft.body, draft.attach_quote, draft.delay_hours]);

  // Re-rendered from the server rather than guessed at locally, so what is shown is what
  // would actually be sent.
  useEffect(() => {
    let dead = false;
    const t = setTimeout(() => {
      campaigns.preview(seqId, step.id).then((p) => { if (!dead) setPreview(p); }).catch(() => {});
    }, SAVE_DEBOUNCE + 200);
    return () => { dead = true; clearTimeout(t); };
  }, [seqId, step.id, draft.body, draft.subject, draft.kind, saving]);

  /** Insert at the cursor, not at the end — the wireframe's "click to insert". */
  function insert(token: string) {
    const el = bodyRef.current;
    const tag = `{${token}}`;
    if (!el) { setDraft({ ...draft, body: draft.body + tag }); return; }
    const a = el.selectionStart ?? draft.body.length;
    const b = el.selectionEnd ?? a;
    const next = draft.body.slice(0, a) + tag + draft.body.slice(b);
    setDraft({ ...draft, body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + tag.length, a + tag.length);
    });
  }

  const sends = draft.kind === 'email' || draft.kind === 'sms';

  return (
    <>
      <div className="camp-edit">
        <div className="camp-edit-head">
          <span className="label">
            Step {String(step.position).padStart(2, '0')} · {draft.kind.toUpperCase()} · {hours(draft.delay_hours)}
          </span>
          <span className="camp-head-right">
            <span className="fb-save">
              {unknown.length ? '' : saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}
            </span>
            {!readOnly && (
              <button className="camp-del" onClick={onDelete}>Delete step</button>
            )}
          </span>
        </div>

        <div className="camp-kinds fb-view">
          {KINDS.map((k) => (
            <button key={k.id} data-on={draft.kind === k.id} disabled={readOnly}
                    onClick={() => setDraft({ ...draft, kind: k.id })}>{k.label}</button>
          ))}
        </div>

        <label className="fb-field">
          <span className="label">Send <i>· after the previous step</i></span>
          <span className="camp-delay">
            <input type="number" min={0} max={8760} value={draft.delay_hours} disabled={readOnly}
                   onChange={(e) => setDraft({ ...draft, delay_hours: Number(e.target.value) })} />
            <span>hours</span>
          </span>
        </label>

        {draft.kind === 'email' && (
          <label className="fb-field">
            <span className="label">Subject</span>
            <input value={draft.subject ?? ''} disabled={readOnly}
                   placeholder="Checking in on your {product} quote"
                   onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </label>
        )}

        <label className="fb-field">
          <span className="label">{draft.kind === 'task' ? 'What the rep should do' : 'Body'}</span>
          <textarea ref={bodyRef} rows={9} value={draft.body} disabled={readOnly}
                    className={unknown.length ? 'bad' : undefined}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </label>

        {sends && (
          <>
            <div className="camp-tokens">
              {TOKENS.map((t) => (
                <button key={t} disabled={readOnly} onClick={() => insert(t)}>{`{${t}}`}</button>
              ))}
            </div>
            <p className="camp-hint">Click to insert at the cursor. An unknown token blocks saving.</p>
          </>
        )}

        {unknown.length > 0 && (
          <p className="team-err">
            Not a token: {unknown.map((t) => `{${t}}`).join(', ')} — saving is paused until it is fixed.
          </p>
        )}

        {draft.kind === 'email' && (
          <label className="fb-check">
            <input type="checkbox" checked={draft.attach_quote} disabled={readOnly}
                   onChange={(e) => setDraft({ ...draft, attach_quote: e.target.checked })} />
            <span>Attach the quote PDF when the ticket has one</span>
          </label>
        )}

        {error && <p className="team-err">{error}</p>}

        <Branches seqId={seqId} stepId={step.id} stepCount={stepCount} position={step.position}
                  branches={step.branches ?? []} readOnly={readOnly} onSaved={onSaved} />
      </div>

      {/* ── what the customer gets ── */}
      <div className="camp-prev">
        <div className="camp-prev-head">
          <span className="label">
            Preview{preview?.against ? ` · ${preview.against.company ?? preview.against.ticket_no}` : ''}
          </span>
        </div>

        {!sends && (
          <p className="camp-empty">
            A {draft.kind} step sends nothing. {draft.kind === 'wait'
              ? 'It only holds the sequence for the delay above.'
              : 'It leaves a task for whoever the ticket is assigned to.'}
          </p>
        )}

        {sends && preview && (
          <div className="camp-mail">
            {draft.kind === 'email' && (
              <>
                <div className="camp-mail-hdr">
                  <span>From</span><b>{preview.from}</b>
                  <span>Reply to</span><b>{preview.reply_to}</b>
                </div>
                <div className="camp-mail-subject">{preview.subject || '(no subject)'}</div>
              </>
            )}
            <div className="camp-mail-body">{preview.body || '(empty)'}</div>
            <div className="camp-mail-foot">{preview.footer}</div>
          </div>
        )}

        {sends && preview && preview.missing.length > 0 && (
          <p className="camp-missing">
            Nothing behind {preview.missing.map((m) => `{${m}}`).join(', ')} on this ticket.
            A send would hold here until a rep fills it in.
          </p>
        )}
        {sends && preview && !preview.missing.length && preview.against && (
          <p className="camp-ok">Every token resolves against {preview.against.ticket_no}.</p>
        )}
        {sends && preview && !preview.against && (
          <p className="camp-missing">No leads yet to preview against.</p>
        )}
      </div>
    </>
  );
}
