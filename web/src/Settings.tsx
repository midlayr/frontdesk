import { useEffect, useState } from 'react';
import { orgSlug } from './api';

interface Messaging {
  voice: { greeting: string; after_record: string; no_input: string; max_seconds: number };
  sms: { auto_reply_enabled: boolean; auto_reply: string; signature: string };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const u = localStorage.getItem('fd_user');
  const t = sessionStorage.getItem('fd_token');
  if (u) h['x-dev-user'] = u;
  if (t) h['x-admin-token'] = t;
  return h;
}
const url = (p: string) => `${p}${p.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;

/** Everything the system says to a customer, in one place. */
export function Settings() {
  const [m, setM] = useState<Messaging | null>(null);
  const [base, setBase] = useState<Messaging | null>(null);
  const [fallback, setFallback] = useState<Messaging | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(url('/api/settings/messaging'), { headers: headers() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setM(d.messaging); setBase(d.messaging); setFallback(d.defaults); })
      .catch((e) => setErr(String(e)));
  }, []);

  const dirty = !!m && !!base && JSON.stringify(m) !== JSON.stringify(base);

  async function save() {
    if (!m) return;
    setState('saving');
    setErr('');
    try {
      const r = await fetch(url('/api/settings/messaging'), { method: 'PUT', headers: headers(), body: JSON.stringify(m) });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? String(r.status));
      setBase(m);
      setState('saved');
      setTimeout(() => setState('idle'), 1600);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''));
      setState('idle');
    }
  }

  if (err && !m) return <div className="fb-empty">{err}</div>;
  if (!m || !fallback) return <div className="fb-empty">Loading…</div>;

  const v = m.voice, s = m.sms;
  const setVoice = (p: Partial<Messaging['voice']>) => setM({ ...m, voice: { ...v, ...p } });
  const setSms = (p: Partial<Messaging['sms']>) => setM({ ...m, sms: { ...s, ...p } });

  return (
    <div className="fb">
      <header className="fb-head">
        <div>
          <span className="label">Settings</span>
          <h2 className="fb-name">Messaging</h2>
        </div>
        <span className="fb-save">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}</span>
        <button className={`fb-publish${dirty ? ' dirty' : ''}`} onClick={save} disabled={!dirty || state === 'saving'}>
          {dirty ? 'Save changes' : 'Saved'}
        </button>
      </header>

      <div className="set-scroll">
        <section className="set-card">
          <div className="set-head">
            <h3 className="fb-edit-title">Voicemail</h3>
            <p className="set-note">
              Spoken by Twilio when someone calls and nobody picks up. <code>{'{org}'}</code> becomes your
              business name.
            </p>
          </div>

          <Field label="Greeting" hint="played before the beep"
                 onReset={v.greeting !== fallback.voice.greeting ? () => setVoice({ greeting: fallback.voice.greeting }) : undefined}>
            <textarea rows={3} value={v.greeting} onChange={(e) => setVoice({ greeting: e.target.value })} />
          </Field>

          <Field label="After they record" hint="the sign-off before hanging up"
                 onReset={v.after_record !== fallback.voice.after_record ? () => setVoice({ after_record: fallback.voice.after_record }) : undefined}>
            <textarea rows={2} value={v.after_record} onChange={(e) => setVoice({ after_record: e.target.value })} />
          </Field>

          <Field label="If they leave nothing" hint="caller hung up without speaking"
                 onReset={v.no_input !== fallback.voice.no_input ? () => setVoice({ no_input: fallback.voice.no_input }) : undefined}>
            <textarea rows={2} value={v.no_input} onChange={(e) => setVoice({ no_input: e.target.value })} />
          </Field>

          <Field label="Maximum length" hint="seconds of recording">
            <input type="number" min={10} max={600} value={v.max_seconds}
                   onChange={(e) => setVoice({ max_seconds: Number(e.target.value) })} style={{ width: 120 }} />
          </Field>
        </section>

        <section className="set-card">
          <div className="set-head">
            <h3 className="fb-edit-title">Text messages</h3>
            <p className="set-note">
              Tokens: <code>{'{org}'}</code>, <code>{'{ticket}'}</code>.
            </p>
          </div>

          <label className="fb-check">
            <input type="checkbox" checked={s.auto_reply_enabled}
                   onChange={(e) => setSms({ auto_reply_enabled: e.target.checked })} />
            <span>Send an automatic acknowledgement to a first text</span>
          </label>

          <Field label="Acknowledgement" hint="only on a new ticket, never mid-conversation">
            <textarea rows={2} value={s.auto_reply} disabled={!s.auto_reply_enabled}
                      onChange={(e) => setSms({ auto_reply: e.target.value })} />
            <Counter text={s.auto_reply} />
          </Field>

          <Field label="Signature" hint="appended to every reply a rep sends · leave blank for none">
            <textarea rows={2} value={s.signature} placeholder="— Dumont Printing · (559) 785-2474"
                      onChange={(e) => setSms({ signature: e.target.value })} />
            <Counter text={s.signature} />
          </Field>

          <div className="set-preview">
            <span className="label">A reply will look like</span>
            <div className="bubble out" style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
              Got it, quoting now{s.signature ? `\n\n${s.signature}` : ''}
            </div>
          </div>
        </section>

        {err && <p className="fb-err">{err}</p>}
      </div>
    </div>
  );
}

/** Segments matter: every 160 characters is another message Dumont pays for. */
function Counter({ text }: { text: string }) {
  const len = text.length;
  const segments = len === 0 ? 0 : Math.ceil(len / 160);
  return (
    <span className="label" style={{ color: segments > 1 ? 'var(--warn)' : 'var(--ink-3)' }}>
      {len} characters{segments > 1 ? ` · ${segments} SMS segments` : segments === 1 ? ' · 1 segment' : ''}
    </span>
  );
}

function Field({ label, hint, children, onReset }: {
  label: string; hint?: string; children: React.ReactNode; onReset?: () => void;
}) {
  return (
    <div className="fb-field">
      <span className="label">
        {label}{hint && <i> · {hint}</i>}
        {onReset && <button type="button" className="set-reset" onClick={onReset}>reset to default</button>}
      </span>
      {children}
    </div>
  );
}
