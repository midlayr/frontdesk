import { useState } from 'react';
import { campaigns } from './campaigns-api';

/**
 * New sequence (wireframe 1a).
 *
 * The trigger is the one decision that is awkward to change later — it determines who ever
 * enters the campaign — so it is asked once, up front, as six cards rather than a dropdown.
 *
 * "Stops on" is shown but not editable. Those are platform rules, and presenting them as
 * settings would imply a shop could switch off stopping when somebody replies.
 */

const TRIGGERS: { id: string; label: string; note: string; needsDays?: boolean; soon?: boolean }[] = [
  { id: 'lead_created', label: 'A lead arrives', note: 'any channel · starts at once' },
  { id: 'quoted_no_reply', label: 'Quoted, no reply', note: 'after N days', needsDays: true },
  { id: 'manual', label: 'Manual', note: 'a rep enrolls from a ticket' },
  { id: 'reorder_due', label: 'Reorder due', note: 'needs the Pipeline radar', soon: true },
  { id: 'lapsed', label: 'Lapsed customer', note: 'needs the Pipeline radar', soon: true },
  { id: 'list', label: 'Uploaded list', note: 'needs list import', soon: true },
];

const CHANNELS = [
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'SMS' },
];

export function NewSequence({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('manual');
  const [channel, setChannel] = useState('email');
  const [days, setDays] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = TRIGGERS.find((t) => t.id === trigger);

  async function create() {
    if (!name.trim()) { setError('give it a name'); return; }
    setBusy(true); setError('');
    try {
      const { id } = await campaigns.create({
        name: name.trim(), trigger, channel,
        ...(chosen?.needsDays ? { trigger_config: { days } } : {}),
      } as never);
      onCreated(id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">New campaign</h3>

        <label className="fb-field">
          <span className="label">Name</span>
          <input autoFocus value={name} placeholder="e.g. Quote follow-up"
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        </label>

        <span className="label">Starts when</span>
        <div className="trig">
          {TRIGGERS.map((t) => (
            <button key={t.id} className="trig-card" data-on={trigger === t.id} disabled={t.soon}
                    onClick={() => setTrigger(t.id)}>
              <b>{t.label}</b>
              <i>{t.note}</i>
              {t.soon && <em>not wired yet</em>}
            </button>
          ))}
        </div>

        {chosen?.needsDays && (
          <label className="fb-field">
            <span className="label">After how many days</span>
            <span className="camp-delay">
              <input type="number" min={1} max={90} value={days}
                     onChange={(e) => setDays(Number(e.target.value))} />
              <span>days at Quoted with no reply</span>
            </span>
          </label>
        )}

        <span className="label">Channel</span>
        <div className="fb-view" style={{ width: 'fit-content' }}>
          {CHANNELS.map((ch) => (
            <button key={ch.id} data-on={channel === ch.id} onClick={() => setChannel(ch.id)}>
              {ch.label}
            </button>
          ))}
        </div>

        <div className="stops">
          <span className="label">Stops on <i>· always</i></span>
          <p>Any reply · opt-out · the ticket reaching Won or Lost · a rep taking over</p>
        </div>

        {error && <p className="team-err">{error}</p>}

        <div className="modal-actions">
          <button className="btn-primary" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <span className="appear-live">Created switched off — you turn it on after writing a step.</span>
        </div>
      </div>
    </div>
  );
}
