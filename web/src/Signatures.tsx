import { useEffect, useState } from 'react';
import { flowsApi } from './flows-api';

/**
 * Each rep's sign-off, used by {sender_signature} in campaigns.
 *
 * So a follow-up about Sean's customer ends the way Sean ends one. A rep with nothing
 * written here falls back to the shop's signature, which the placeholder shows — the point
 * being that the mail is always signed, never signed with a blank.
 */

interface Person { id: string; name: string; email: string; role: string }

export function Signatures() {
  const [people, setPeople] = useState<Person[]>([]);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');

  useEffect(() => {
    flowsApi.signatures()
      .then((r) => { setPeople(r.people); setSaved(r.signatures); setDraft(r.signatures); setFallback(r.fallback); })
      .catch((e) => setErr(String(e)));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    setState('saving'); setErr('');
    try {
      const r = await flowsApi.saveSignatures(draft);
      setSaved(r.signatures); setDraft(r.signatures); setState('saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e));
      setState('idle');
    }
  }

  return (
    <section className="set-card">
      <div className="set-head">
        <h3 className="fb-edit-title">Signatures</h3>
        <p className="set-note">
          Used by <code>{'{sender_signature}'}</code> in a campaign, so a follow-up about
          someone's customer ends the way they would end it. Anyone left blank signs off as{' '}
          <b>{fallback || 'the shop'}</b>.
        </p>
      </div>

      {err && <p className="team-err">{err}</p>}
      {!people.length && !err && <p className="set-note">Loading…</p>}

      <div className="sig-list">
        {people.map((p) => (
          <label key={p.id} className="fb-field">
            <span className="label">
              {p.name || p.email}
              {p.role === 'admin' && <i> · admin</i>}
            </span>
            <textarea rows={3} value={draft[p.id] ?? ''}
                      placeholder={fallback}
                      onChange={(e) => { setDraft({ ...draft, [p.id]: e.target.value }); setState('idle'); }} />
          </label>
        ))}
      </div>

      <div className="invite-acts">
        <button className="btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save signatures'}
        </button>
        <span className="team-note" style={{ margin: 0, alignSelf: 'center' }}>
          {state === 'saved' ? 'Saved.' : dirty ? 'Unsaved changes.' : ''}
        </span>
      </div>
    </section>
  );
}
