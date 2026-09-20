import { useEffect, useState } from 'react';
import { api, STATUS_DOT, STATUS_LABEL, type Event, type History as Hist, type OrgUser } from './api';

/**
 * How a lead travelled the pipeline.
 *
 * Two things layered on one list. The events themselves — created, message in, reply,
 * edit, assignment — and the stage segments derived from them: a ticket's stage history is
 * not stored as durations anywhere, it is the gaps between consecutive 'stage' rows, with
 * the first segment running from the lead's creation and the last still open.
 *
 * Time in stage is the point of the exercise. "Quoted" tells a rep nothing; "Quoted, 9
 * days" tells them to pick up the phone.
 */

const FIELD_WORD: Record<string, string> = {
  'contact.name': 'name', 'contact.company': 'company',
  'contact.email': 'email', 'contact.phone': 'phone',
};

function since(from: string, to: string): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime());
  const m = Math.round(ms / 60000);
  if (m < 1) return 'moments';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Time of day on the entry; the date is carried by the day heading above it. */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const dayKey = (iso: string) => new Date(iso).toDateString();

/** Today and Yesterday by name, anything older by date — a log is read by recency first. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/** Who did it — a rep's name, or the system for anything the platform did on its own. */
function who(e: Event, users: OrgUser[]): string {
  if (e.actor === 'system') return 'Front Desk';
  return e.actor_name || users.find((u) => u.id === e.actor)?.name || 'a rep';
}

function describe(e: Event, users: OrgUser[]): { text: string; strong?: boolean } | null {
  const d = (e.detail ?? {}) as Record<string, string | string[] | null>;
  const name = (id: string | null | undefined) =>
    !id ? null : users.find((u) => u.id === id)?.name ?? 'someone';

  switch (e.kind) {
    case 'lead_created':
      return { text: `Ticket ${d.ticket_no ?? ''} created from ${d.channel ?? 'an enquiry'}`.trim() };
    case 'message_in':
      return { text: `Message in over ${d.channel ?? 'a channel'}` };
    case 'voicemail_received':
      return { text: 'Voicemail received' };
    case 'specs_extracted': {
      const missing = Array.isArray(d.missing) ? d.missing : [];
      return { text: missing.length ? `Specs read · still missing ${missing.join(', ')}` : 'Specs read from the message' };
    }
    case 'replied':
      return { text: `${who(e, users)} replied by ${d.channel ?? 'sms'}` };
    case 'takeover':
      return { text: `${who(e, users)} took over the chat` };
    case 'edited': {
      const fields = (Array.isArray(d.fields) ? d.fields : []).map((f) => FIELD_WORD[f] ?? f);
      return fields.length ? { text: `${who(e, users)} edited ${fields.join(', ')}` } : null;
    }
    case 'assigned':
      return {
        text: d.to
          ? `${who(e, users)} assigned it to ${name(d.to as string) ?? 'someone'}`
          : `${who(e, users)} removed the assignee`,
      };
    case 'stage': {
      const move = `${STATUS_LABEL[d.from as string] ?? d.from} → ${STATUS_LABEL[d.to as string] ?? d.to}`;
      // Distinguished so nobody reads an automatic move as a colleague's decision.
      return { strong: true, text: (e.detail as { auto?: boolean })?.auto ? `${move} · automatic` : move };
    }
    default:
      return { text: e.kind.replace(/_/g, ' ') };
  }
}

/** The stage the ticket was in at each point, and for how long. */
function segments(h: Hist): { status: string; at: string; until: string; open: boolean }[] {
  const moves = h.activity.filter((e) => e.kind === 'stage');
  const out: { status: string; at: string; until: string; open: boolean }[] = [];
  const now = new Date().toISOString();

  let at = h.created_at;
  let status = (moves[0]?.detail as { from?: string } | null)?.from ?? h.status;
  for (const m of moves) {
    const to = (m.detail as { to?: string } | null)?.to;
    out.push({ status, at, until: m.at, open: false });
    status = to ?? status;
    at = m.at;
  }
  out.push({ status, at, until: now, open: true });
  return out;
}

export function History({ leadId, users }: { leadId: string; users: OrgUser[] }) {
  const [h, setH] = useState<Hist | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setH(null);
    api.activity(leadId).then(setH).catch(() => {});
  }, [leadId]);

  if (!h) return null;
  const segs = segments(h);
  const current = segs[segs.length - 1];
  // The events worth showing by default; edits are noise until someone goes looking.
  const shown = open ? h.activity : h.activity.filter((e) => e.kind !== 'edited');

  return (
    <>
      <div className="section">
        History
        <button className="hist-toggle" onClick={() => setOpen(!open)}>
          {open ? 'hide edits' : 'show edits'}
        </button>
      </div>

      <div className="hist-stages">
        {segs.map((s, i) => (
          <span key={i} className={`hist-stage${s.open ? ' now' : ''}`}>
            <i className="dot" style={{ background: STATUS_DOT[s.status] ?? 'var(--ink-3)' }} />
            {STATUS_LABEL[s.status] ?? s.status}
            <b>{since(s.at, s.until)}</b>
          </span>
        ))}
      </div>
      <p className="hist-now">
        {STATUS_LABEL[current.status] ?? current.status} for {since(current.at, current.until)}
        {' · '}open {since(h.created_at, new Date().toISOString())}
      </p>

      <ol className="hist">
        {shown.map((e, i) => {
          const line = describe(e, users);
          if (!line) return null;
          const newDay = i === 0 || dayKey(e.at) !== dayKey(shown[i - 1].at);
          return (
            <li key={e.id} className={line.strong ? 'strong' : undefined}>
              {newDay && <span className="hist-day">{dayLabel(e.at)}</span>}
              <span className="hist-row">
                <time className="hist-at" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                  {clock(e.at)}
                </time>
                <span className="hist-what">{line.text}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
