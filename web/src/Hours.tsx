import { useEffect, useState } from 'react';
import { flowsApi } from './flows-api';

/**
 * When the shop is open.
 *
 * One set of hours for the whole shop, not one per bot: the quotes bot and the reorders
 * bot are the same front counter. Two things read this — the chat bot, deciding which
 * closing line a visitor gets, and the campaign sender, which has always refused to post
 * marketing at 3am.
 */

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
];

// The zones a US print shop plausibly sits in, plus whatever is already saved.
const ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Phoenix',
  'America/Chicago', 'America/New_York', 'UTC',
];

interface Shape { days: number[]; start: string; end: string; tz: string }

export function Hours() {
  const [saved, setSaved] = useState<Shape | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [described, setDescribed] = useState('');
  const [open, setOpen] = useState<boolean | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    flowsApi.hours()
      .then((r) => {
        const h = r.hours as Shape;
        setSaved(h); setDraft(h); setDescribed(r.described); setOpen(r.open);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (!draft) return <section className="set-card"><p className="set-note">{err || 'Loading…'}</p></section>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const toggle = (n: number) => setDraft({
    ...draft,
    days: draft.days.includes(n) ? draft.days.filter((d) => d !== n) : [...draft.days, n].sort(),
  });

  async function save() {
    if (!draft) return;
    setState('saving'); setErr('');
    try {
      const r = await flowsApi.saveHours(draft);
      setSaved(r.hours as Shape); setDraft(r.hours as Shape);
      setDescribed(r.described); setOpen(r.open); setState('saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e));
      setState('idle');
    }
  }

  return (
    <section className="set-card">
      <div className="set-head">
        <h3 className="fb-edit-title">Opening hours</h3>
        <p className="set-note">
          The chat bot uses these to decide what to say when somebody finishes a request out
          of hours, and campaigns will not send outside them.
          {open !== null && (
            <> You are <b>{open ? 'open' : 'closed'}</b> right now.</>
          )}
        </p>
      </div>

      <div className="hours-days">
        {DAYS.map((d) => (
          <button key={d.n} type="button" className="hours-day"
                  data-on={draft.days.includes(d.n)}
                  aria-pressed={draft.days.includes(d.n)}
                  onClick={() => { toggle(d.n); setState('idle'); }}>
            {d.label}
          </button>
        ))}
      </div>

      <div className="hours-row">
        <label className="fb-field">
          <span className="label">Opens</span>
          <input type="time" value={draft.start}
                 onChange={(e) => { setDraft({ ...draft, start: e.target.value }); setState('idle'); }} />
        </label>
        <label className="fb-field">
          <span className="label">Closes</span>
          <input type="time" value={draft.end}
                 onChange={(e) => { setDraft({ ...draft, end: e.target.value }); setState('idle'); }} />
        </label>
        <label className="fb-field">
          <span className="label">Time zone</span>
          <select value={draft.tz}
                  onChange={(e) => { setDraft({ ...draft, tz: e.target.value }); setState('idle'); }}>
            {[...new Set([draft.tz, ...ZONES])].map((z) => (
              <option key={z} value={z}>{z.replace('America/', '').replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
      </div>

      {!draft.days.length && (
        <p className="setup-warn">
          No days selected, so the shop counts as closed at every hour — every visitor will
          get the out-of-hours message.
        </p>
      )}

      <div className="invite-acts">
        <button className="btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save hours'}
        </button>
        <span className="team-note" style={{ margin: 0, alignSelf: 'center' }}>
          {state === 'saved' ? `Saved — ${described}.` : dirty ? 'Unsaved changes.' : described}
        </span>
      </div>
      {err && <p className="team-err">{err}</p>}
    </section>
  );
}
