import { Team } from './Team';
import { useEffect, useState } from 'react';
import { orgSlug } from './api';

interface Voice { id: string; label: string; neural: boolean }

interface Messaging {
  voice: { greeting: string; after_record: string; no_input: string; max_seconds: number; tts_voice: string };
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
export function Settings({ me, tab, go }: {
  me: { id: string; role: string } | null;
  tab: 'messaging' | 'people';
  go: (to: string) => void;
}) {
  if (tab === 'people') {
    return (
      <div className="fb">
        <header className="fb-head">
          <div>
            <span className="label">Settings</span>
            <h2 className="fb-name">People</h2>
          </div>
          <Tabs tab={tab} go={go} />
        </header>
        <div className="set-scroll"><Team me={me} /></div>
      </div>
    );
  }
  return <Messaging tab={tab} go={go} />;
}

function Tabs({ tab, go }: { tab: string; go: (to: string) => void }) {
  return (
    <span className="fb-view" style={{ marginLeft: 'auto' }}>
      <button data-on={tab === 'messaging'} onClick={() => go('/settings/messaging')}>Messaging</button>
      <button data-on={tab === 'people'} onClick={() => go('/settings/people')}>People</button>
    </span>
  );
}

function Messaging({ tab, go }: { tab: string; go: (to: string) => void }) {
  const [m, setM] = useState<Messaging | null>(null);
  const [base, setBase] = useState<Messaging | null>(null);
  const [fallback, setFallback] = useState<Messaging | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');
  const [previewTo, setPreviewTo] = useState(() => localStorage.getItem('fd_preview_to') ?? '');
  const [previewState, setPreviewState] = useState<'idle' | 'calling' | 'ringing' | 'failed'>('idle');
  const [previewErr, setPreviewErr] = useState('');

  useEffect(() => {
    fetch(url('/api/settings/messaging'), { headers: headers() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setM(d.messaging); setBase(d.messaging); setFallback(d.defaults); setVoices(d.voices ?? []); })
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

  /** Twilio has no synthesis endpoint, so the only faithful preview is a real call. */
  async function preview() {
    if (!m) return;
    const to = previewTo.replace(/[^\d+]/g, '');
    const e164 = to.startsWith('+') ? to : `+1${to.replace(/^1/, '')}`;
    localStorage.setItem('fd_preview_to', previewTo);
    setPreviewState('calling');
    setPreviewErr('');
    try {
      const r = await fetch(url('/api/settings/messaging/preview'), {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ to: e164, voice: m.voice.tts_voice, text: m.voice.greeting }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? String(r.status));
      setPreviewState('ringing');
      setTimeout(() => setPreviewState('idle'), 8000);
    } catch (e) {
      setPreviewErr(String(e).replace(/^Error:\s*/, ''));
      setPreviewState('failed');
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
        <Tabs tab={tab} go={go} />
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

          <Field label="Voice" hint="neural voices sound markedly less synthetic">
            <select value={v.tts_voice} onChange={(e) => setVoice({ tts_voice: e.target.value })}>
              <optgroup label="Neural">
                {voices.filter((x) => x.neural).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </optgroup>
              <optgroup label="Standard · cheaper per character">
                {voices.filter((x) => !x.neural).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </optgroup>
            </select>
            <span className="label">
              {voices.find((x) => x.id === v.tts_voice)?.neural
                ? 'Neural — costs more per character than standard.'
                : 'Standard — this is the flat, robotic-sounding engine.'}
            </span>
          </Field>

          <div className="set-preview">
            <span className="label">Hear it</span>
            <p className="set-note" style={{ fontSize: 'var(--text-sm)' }}>
              Twilio rings you and reads the greeting above in the selected voice. That is the
              only accurate preview — your browser's built-in speech uses different voices
              entirely and would not tell you anything useful.
            </p>
            <div className="set-call">
              <input value={previewTo} placeholder="(559) 555-0123"
                     onChange={(e) => setPreviewTo(e.target.value)} />
              <button className="btn-ghost" type="button" onClick={preview}
                      disabled={previewState === 'calling' || previewTo.replace(/\D/g, '').length < 10}>
                {previewState === 'calling' ? 'Calling…' : previewState === 'ringing' ? 'Ringing you now' : 'Call me'}
              </button>
            </div>
            {previewErr && <span className="err">{previewErr}</span>}
          </div>

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
