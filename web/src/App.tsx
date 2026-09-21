import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, applyBrand, orgSlug, userId, type Attachment, type Lead, type Message, type Org, PIPELINE, STATUS_LABEL, STATUS_DOT, type OrgUser } from './api';
import { FlowBuilder } from './FlowBuilder';
import { Campaigns } from './Campaigns';
import { History } from './History';
import { TicketSequences } from './TicketSequences';
import { Settings } from './Settings';

const VIEWS = ['All', 'New', 'Mine', 'Rush', 'Working', 'Quoted', 'Won', 'Lost', 'Spam', 'Archived'] as const;
type View = (typeof VIEWS)[number];

// Same labels as the ticket's status picker, from the same map in api.ts: a stage renamed
// there must not leave the rail saying something else about the very same rows.
const STATUS_OF: Partial<Record<View, string>> = {
  New: 'new', Working: 'needs_info', Quoted: 'quoted', Won: 'won', Lost: 'lost', Spam: 'spam',
};

const CHANNEL_TAG: Record<string, string> = { sms: 'SM', voice: 'VM', email: 'EM', form: 'WF', chat: 'CB' };

const FRESH_MS = 45_000;

/**
 * Derived from the row's own timestamps rather than by diffing successive polls.
 * Diffing needs a ref that survives every remount, hot reload and socket reconnect — and
 * when it does not, the highlight silently stops working, which is the worst failure mode
 * for something whose whole job is to catch your eye.
 */
const isFresh = (l: Lead) => {
  const t = l.last_in_at ?? l.created_at;
  return !!t && Date.now() - new Date(t).getTime() < FRESH_MS;
};

/**
 * The left bar. BRAND.md: live/replied green, rush/needs-info amber, and red reserved for
 * destructive actions — the one exception being a deadline that has actually passed, which
 * is the only state on this screen that is genuinely an emergency.
 */
function urgency(l: Lead): { color: string; label: string } {
  const due = l.deadline_at ? new Date(l.deadline_at).getTime() : null;
  const hoursLeft = due === null ? null : (due - Date.now()) / 3_600_000;

  if (l.rush || (hoursLeft !== null && hoursLeft < 0)) {
    return { color: 'var(--rush)', label: hoursLeft !== null && hoursLeft < 0 ? 'overdue' : 'rush' };
  }
  if (l.status === 'live') return { color: 'var(--ok)', label: 'live' };
  if (hoursLeft !== null && hoursLeft < 24) return { color: 'var(--warn)', label: 'due today' };
  if (l.status === 'needs_info') return { color: 'var(--warn)', label: 'needs info' };
  if (l.status === 'replied' || l.status === 'quoted') return { color: 'var(--ok)', label: l.status };
  return { color: 'transparent', label: l.status };
}

function age(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** The one-line spec summary under each queue row, in the reference's order. */
function summarise(l: Lead) {
  const head = [l.qty ?? null, l.stock ?? l.product ?? null].filter(Boolean).join(' · ');
  const tail = [l.finish, l.color, l.size].filter(Boolean).join(', ');
  return { head: head || 'no specs yet', tail };
}

function matches(l: Lead, v: View) {
  if (v === 'Archived') return true;   // the server already filtered to archived rows
  if (v === 'All') return true;
  if (v === 'Rush') return l.rush;
  if (v === 'Mine') return l.assignee_id === userId;
  return l.status === STATUS_OF[v];
}

/** Just enough routing for two screens; a router library would outweigh the problem. */
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const go = useCallback((to: string) => {
    history.pushState({}, '', to + location.search);
    setPath(to);
  }, []);
  return [path, go] as const;
}

export function App() {
  const [path, go] = usePath();
  const [org, setOrg] = useState<Org | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [error, setError] = useState('');
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [me, setMe] = useState<{ id: string; name: string; email: string; role: string } | null>(null);
  const [streamUp, setStreamUp] = useState(false);
  const [ackedAt, setAckedAt] = useState(() => Date.now());
  const [leads, setLeads] = useState<Lead[]>([]);
  // Ticks so time-derived state (freshness, overdue) decays without a server round trip.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const [view, setView] = useState<View>('All');
  // refresh() is a stable callback shared with the socket, so the current view is read from
  // a ref rather than baked into its closure.
  const viewRef = useRef<View>('All');
  useEffect(() => { viewRef.current = view; }, [view]);
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ lead: Lead; messages: Message[]; attachments: Attachment[] } | null>(null);
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const chatWs = useRef<WebSocket | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { leads } = await api.leads({ archived: viewRef.current === 'Archived' });

      setLeads(leads);
      setError('');
    } catch (e) {
      const msg = String(e);
      if (/\b401\b|\b501\b/.test(msg)) setNeedToken(true);
      else setError(msg);
    }
  }, []);

  // boot: brand first so the shell never flashes the platform accent
  useEffect(() => {
    (async () => {
      try {
        const o = await api.org();
        setOrg(o);
        applyBrand(o);
        await refresh();
      } catch (e) {
        if (/\b401\b|\b501\b/.test(String(e))) setNeedToken(true);
        else setError(String(e));
      }
    })();
  }, [refresh]);

  /**
   * Realtime queue: InboxRoom pushes on new leads and chat turns.
   *
   * Reconnects on drop. Without this the socket dies on a laptop sleeping, a network blip or
   * a dev hot-reload, and the queue just quietly stops updating — a rep would sit in front of
   * a stale list with no indication anything was wrong, which is worse than no realtime.
   * Also re-syncs on reconnect, since anything that happened while we were away was missed.
   */
  useEffect(() => {
    if (!org) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let attempt = 0;
    let timer: number | undefined;

    const open = async () => {
      if (stop) return;
      try {
        ws = await api.socket('/api/inbox/stream');
        if (stop) return ws.close();
        ws.onopen = () => { attempt = 0; setStreamUp(true); refresh(); };
        ws.onmessage = () => refresh();
        ws.onclose = () => {
          setStreamUp(false);
          if (stop) return;
          const wait = Math.min(30000, 1000 * 2 ** attempt++);   // 1s, 2s, 4s … capped
          timer = setTimeout(open, wait) as unknown as number;
        };
      } catch {
        if (stop) return;
        const wait = Math.min(30000, 1000 * 2 ** attempt++);
        timer = setTimeout(open, wait) as unknown as number;
      }
    };
    open();

    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [org, refresh]);

  const openLead = useCallback(async (id: string) => {
    setSelId(id);
    setLive(false);
    chatWs.current?.close();
    chatWs.current = null;
    const d = await api.lead(id);
    setDetail({ lead: d.lead, messages: d.messages, attachments: d.attachments ?? [] });

    if (d.lead.channel === 'chat' && d.lead.chat_sid) {
      const ws = await api.socket(`/api/leads/${id}/chat`);
      chatWs.current = ws;
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'turn') {
          setDetail((prev) => prev && {
            ...prev,
            messages: [...prev.messages, {
              id: `ws-${Date.now()}-${Math.random()}`,
              channel: 'chat',
              direction: m.turn.who === 'visitor' ? 'in' : 'out',
              author: m.turn.who,
              body: m.turn.text,
              sent_at: new Date(m.turn.at).toISOString(),
            }],
          });
        }
        if (m.type === 'joined') setLive(true);
      };
    }
  }, []);

  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end' }); }, [detail?.messages.length]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => matches(l, view) && (!q ||
      [l.ticket_no, l.product, l.contact_name, l.contact_phone, l.contact_email]
        .some((v) => v?.toLowerCase().includes(q))));
  }, [leads, view, query]);

  const groups = useMemo(() => {
    const inChat = shown.filter((l) => l.status === 'live');
    const rush = shown.filter((l) => l.rush && l.status !== 'live');
    const rest = shown.filter((l) => !l.rush && l.status !== 'live');
    return [
      { title: `In chat now · ${inChat.length}`, rows: inChat },
      { title: `Rush · ${rush.length}`, rows: rush },
      { title: `Today · ${rest.length}`, rows: rest },
    ].filter((g) => g.rows.length);
  }, [shown]);

  // Arrived since the rep last acknowledged the queue. Survives reconnects because it is
  // derived from created_at, not from diffing polls.
  const newSinceAck = useMemo(
    () => leads.filter((l) => new Date(l.created_at).getTime() > ackedAt).length,
    [leads, ackedAt],
  );

  const counts = useMemo(() => ({
    new: leads.filter((l) => l.status === 'new').length,
    rush: leads.filter((l) => l.rush).length,
  }), [leads]);

  async function send() {
    const body = draft.trim();
    if (!body || !detail) return;
    setDraft('');
    // A live chat goes down the socket; anything else is a channel reply (SMS today).
    if (chatWs.current?.readyState === WebSocket.OPEN) {
      chatWs.current.send(JSON.stringify({ type: 'say', text: body, repId: userId }));
      return;
    }
    setSending(true);
    try {
      await api.reply(detail.lead.id, body);
      await openLead(detail.lead.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  /** Optimistic enough to feel instant: the response carries the recomputed row. */
  async function patchLead(body: Record<string, unknown>) {
    if (!detail) return;
    try {
      const r = await api.patch(detail.lead.id, body);
      if (r?.lead) setDetail((prev) => (prev ? { ...prev, lead: { ...prev.lead, ...r.lead } } : prev));
      await refresh();
    } catch (e) { setError(String(e)); }
  }

  // The assignee list changes far less often than the queue, so it is fetched once.
  useEffect(() => { api.users().then(setUsers).catch(() => {}); }, []);
  useEffect(() => { api.me().then((r) => setMe(r.user)).catch(() => {}); }, []);

  async function archiveLead(on: boolean) {
    if (!detail) return;
    try {
      await api.archive(detail.lead.id, !on);
      setSelId(null);
      setDetail(null);
      await refresh();
    } catch (e) { setError(String(e)); }
  }

  /** Irreversible and takes the recordings with it, so it asks first and names the ticket. */
  async function deleteLead() {
    if (!detail) return;
    const t = detail.lead.ticket_no;
    if (!confirm(`Delete ${t} permanently?\n\nThe conversation, any voicemail recordings and attachments go with it. This cannot be undone — use Archive if you just want it out of the queue.`)) return;
    try {
      await api.remove(detail.lead.id);
      setSelId(null);
      setDetail(null);
      await refresh();
    } catch (e) { setError(String(e)); }
  }

  async function takeover() {
    if (!detail) return;
    try {
      await api.takeover(detail.lead.id);
      setLive(true);
      await openLead(detail.lead.id);
      await refresh();
    } catch (e) { setError(String(e)); }
  }

  if (needToken) return <Login onDone={() => location.reload()} />;

  const flowSlug = path.startsWith('/chat/flows/') ? path.slice('/chat/flows/'.length) : '';
  const onSettings = path.startsWith('/settings');
  const onCampaigns = path.startsWith('/campaigns');
  const brand = (org?.brand ?? {}) as Record<string, string>;
  const logo = brand.logo_url ? `${brand.logo_url}` : '/brand/dumont/logo-horizontal.png';

  return (
    <div className="app">
      <header className="top">
        <img className="logo" src={logo} alt={org?.name ?? ''} />
        <span className="rule" />
        <span className="wordmark">{brand.app_name?.replace(/^.*?\s/, '') || 'Front Desk'}</span>
        <span className="powered">powered by Midlayr</span>
        <nav className="nav">
          <button aria-current={!flowSlug} onClick={() => go('/')}>Inbox</button>
          <button aria-current={onCampaigns} onClick={() => go('/campaigns')}>Campaigns</button>
          <button aria-current={!!flowSlug} onClick={() => go('/chat/flows/quote-intake')}>Chat</button>
          <button aria-current={onSettings} onClick={() => go('/settings/messaging')}>Settings</button>
        </nav>
        <div className="search">
          <input placeholder="Search leads" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="counts">
          <span className={`dot${streamUp ? ' ok pulse' : ''}`} style={{ display: 'inline-block', marginRight: 6 }} />
          {counts.new} new · {counts.rush} rush
        </span>
      </header>

      {onCampaigns ? (
        <Campaigns me={me} />
      ) : onSettings ? (
        <Settings me={me} org={org}
                  tab={path.startsWith('/settings/people') ? 'people'
                     : path.startsWith('/settings/appearance') ? 'appearance' : 'messaging'}
                  go={go} />
      ) : flowSlug ? (
        <FlowBuilder slug={flowSlug} accent={brand.color || '#0B7FA8'} />
      ) : (
      <div className="panes">
        <aside className="rail">
          <span className="eyebrow">Views</span>
          {VIEWS.map((v) => (
            <button key={v} aria-current={view === v}
                    onClick={() => { viewRef.current = v; setView(v); setSelId(null); setDetail(null); refresh(); }}>
              <span>{v}</span>
              {/* Archived rows are filtered out server-side, so the loaded list contains none
                  of them and counting it here reported the whole queue as archived. The
                  count is only knowable while that view is the one being shown. */}
              <span>
                {v === 'All' ? leads.length
                  : v === 'Archived' ? (view === 'Archived' ? leads.length : '')
                  : leads.filter((l) => matches(l, v)).length}
              </span>
            </button>
          ))}
          <hr />
          <span className="eyebrow">Channel</span>
          {Object.entries(CHANNEL_TAG).map(([ch, tag]) => (
            <button key={ch} onClick={() => setQuery('')} style={{ cursor: 'default' }}>
              <span style={{ textTransform: 'capitalize' }}>{ch}</span>
              <span>{tag} {leads.filter((l) => l.channel === ch).length || ''}</span>
            </button>
          ))}
        </aside>

        <div className="queue">
          {newSinceAck > 0 && (
            <button className="newpill" onClick={() => {
              setAckedAt(Date.now());
              document.querySelector('.queue')?.scrollTo({ top: 0, behavior: 'smooth' });
            }}>
              {newSinceAck} new lead{newSinceAck > 1 ? 's' : ''}
            </button>
          )}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="qgroup">{g.title}</div>
              {g.rows.map((l) => {
                const s = summarise(l);
                const u = urgency(l);
                const hot = l.status === 'live' || isFresh(l);
                return (
                  <button key={l.id}
                          className={`row${l.status === 'live' ? ' live' : ''}${isFresh(l) ? ' fresh' : ''}`}
                          style={{ borderLeftColor: selId === l.id ? 'var(--ink)' : u.color }}
                          title={u.label}
                          aria-selected={selId === l.id} onClick={() => openLead(l.id)}>
                    <div className="r1">
                      <span className={`dot${hot ? ' ok pulse' : ''}`} style={hot ? undefined : { background: u.color }} />
                      {l.rush && <span className="tag rush">Rush</span>}
                      {l.status === 'live' && <span className="tag live">Live</span>}
                      <span className="name">{l.contact_name ?? l.contact_email ?? l.contact_phone ?? 'Anonymous'}</span>
                      <span className="age">{age(l.created_at)}</span>
                    </div>
                    <div className="r2">
                      <span className="tag" style={{ marginRight: 6 }}>{CHANNEL_TAG[l.channel] ?? l.channel}</span>
                      {s.head}
                    </div>
                    {s.tail && <div className="r3">{s.tail}</div>}
                  </button>
                );
              })}
            </div>
          ))}
          {!groups.length && <div className="qgroup">No leads in this view</div>}
        </div>

        {detail ? (
          <Ticket d={detail} live={live} draft={draft} setDraft={setDraft}
                  send={send} sending={sending} takeover={takeover} error={error}
                  onPatch={patchLead} onArchive={archiveLead} onDelete={deleteLead} users={users} />
        ) : (
          <div className="ticket"><div className="empty">{error || 'Select a ticket'}</div></div>
        )}
      </div>
      )}
      <div ref={threadEnd} />
    </div>
  );
}

/**
 * An <audio> element cannot send an auth header, so it fetches a short-lived signed ticket
 * and carries that in the URL instead. Minted on mount so it is fresh when playback starts.
 */
function Voicemail({ leadId, messageId }: { leadId: string; messageId: string }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    api.mediaTicket()
      .then((t) => { if (!dead) setSrc(`/api/leads/${leadId}/audio/${messageId}?org=${encodeURIComponent(orgSlug)}&ticket=${encodeURIComponent(t)}`); })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; };
  }, [leadId, messageId]);

  if (failed) return <span className="label">Could not load the recording</span>;
  if (!src) return <span className="label">Loading recording…</span>;
  return <audio controls preload="metadata" src={src} />;
}

function SpecCell({ k, v, missing }: { k: string; v: string | number | null; missing: boolean }) {
  return (
    <div className="scell">
      <span className="label">{k}</span>
      <span className={`val${v == null ? ' missing' : ''}`}>{v ?? (missing ? '— ?' : '—')}</span>
    </div>
  );
}

/**
 * A spec or contact value the rep can correct in place.
 *
 * Saves on blur or Enter, and only when the value actually changed — a rep tabbing through
 * the grid to read it should not write to the database on every field.
 */
function EditCell({ leadId, label, value, placeholder, type, onSave }: {
  leadId: string; label: string; value: string | number | null;
  placeholder?: string; type?: string; onSave: (v: string | null) => void;
}) {
  const asText = value == null ? '' : String(value);
  const [v, setV] = useState(asText);
  const [saved, setSaved] = useState(false);

  /**
   * Resets only when the rep opens a different ticket — never on `value` changing.
   *
   * Saving echoes the row back from the server, and feeding that echo into the input while
   * someone is typing interleaves the two and produces things like
   * "Fresno Ag HFresno Ag Hardwareardware". The field owns its text for as long as the
   * ticket is open; the server is the source of truth only when the ticket changes.
   */
  useEffect(() => { setV(asText); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [leadId]);

  /** Autosaves after typing stops, like the flow builder. Blur is too easy to miss. */
  useEffect(() => {
    if (v === asText) return;
    const t = setTimeout(() => {
      onSave(v.trim() === '' ? null : v.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    }, 900);
    return () => clearTimeout(t);
  }, [v, asText, onSave]);

  return (
    <label className={`scell edit${saved ? ' saved' : ''}`}>
      <span className="label">{label}</span>
      <input type={type ?? 'text'} value={v} placeholder={placeholder}
             onChange={(e) => setV(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

function Ticket({ d, live, draft, setDraft, send, sending, takeover, error, onPatch, onArchive, onDelete, users }: {
  d: { lead: Lead; messages: Message[]; attachments?: Attachment[] }; live: boolean; draft: string;
  setDraft: (s: string) => void; send: () => void; sending: boolean;
  takeover: () => void; error: string; onPatch: (body: Record<string, unknown>) => void;
  onArchive: (on: boolean) => void; onDelete: () => void; users: OrgUser[];
}) {
  const l = d.lead;
  const miss = l.missing_fields ?? [];
  const who = l.contact_name ?? l.contact_email ?? l.contact_phone ?? 'Anonymous';
  const isChat = l.channel === 'chat' && !!l.chat_sid;

  return (
    <div className="ticket">
      <div className="tscroll">
        <div className="thead">
          <span className="label">Ticket</span>
          <span className="tno">{l.ticket_no}</span>
          <span style={{ marginLeft: 'auto' }} />

          {/* A live chat's stage belongs to the chat session, not to a rep: the session
              writes 'live' while someone is connected and hands it back when it ends, so
              offering the picker here would only be overwritten. */}
          {l.status === 'live' ? (
            <span className="pick static">
              <i className="dot" style={{ background: STATUS_DOT.live }} />
              {STATUS_LABEL.live}
            </span>
          ) : (
            <label className="pick">
              <i className="dot" style={{ background: STATUS_DOT[l.status] ?? 'var(--ink-3)' }} />
              <select value={l.status} onChange={(e) => onPatch({ status: e.target.value })}>
                {/* A status the picker does not list — 'closed' on an old ticket — is added
                    so selecting it is possible to leave but never to enter. */}
                {(PIPELINE as readonly string[]).includes(l.status)
                  ? null
                  : <option value={l.status}>{STATUS_LABEL[l.status] ?? l.status}</option>}
                {PIPELINE.map((st) => (
                  <option key={st} value={st}>{STATUS_LABEL[st]}</option>
                ))}
              </select>
            </label>
          )}

          <TicketSequences leadId={l.id} />

          <label className="pick assign">
            <span className="label">Assign</span>
            <select value={l.assignee_id ?? ''}
                    onChange={(e) => onPatch({ assignee_id: e.target.value || null })}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </label>
          {isChat && !live && <button className="btn-primary" onClick={takeover}>Take over chat</button>}
          {live && <span className="tag live">You are live</span>}
          <button className="btn-ghost" onClick={() => onArchive(!l.archived_at)}>
            {l.archived_at ? 'Restore' : 'Archive'}
          </button>
          <button className="btn-ghost danger" onClick={onDelete}>Delete</button>
        </div>

        <h1 className="tname">{l.company_name || who}</h1>
        <div className="meta">
          {[l.channel, l.contact_phone, l.contact_email].filter(Boolean).join(' · ').toUpperCase()}
        </div>

        <div className="section">Contact</div>
        <div className="spec">
          <EditCell leadId={l.id} label="name" value={l.contact_name} placeholder="who called?"
                    onSave={(v) => onPatch({ contact: { name: v } })} />
          <EditCell leadId={l.id} label="company" value={l.company_name ?? null} placeholder="company"
                    onSave={(v) => onPatch({ contact: { company: v } })} />
          <EditCell leadId={l.id} label="email" value={l.contact_email} placeholder="email for the quote" type="email"
                    onSave={(v) => onPatch({ contact: { email: v } })} />
          <EditCell leadId={l.id} label="phone" value={l.contact_phone} placeholder="phone"
                    onSave={(v) => onPatch({ contact: { phone: v } })} />
        </div>

        <div className="section">Spec</div>
        <div className="spec">
          <EditCell leadId={l.id} label="qty" value={l.qty} placeholder={miss.includes('qty') ? '— ?' : ''}
                    onSave={(v) => onPatch({ qty: v ? Number(v) : null })} />
          <EditCell leadId={l.id} label="stock" value={l.stock} placeholder={miss.includes('stock') ? '— ?' : ''}
                    onSave={(v) => onPatch({ stock: v })} />
          <EditCell leadId={l.id} label="product" value={l.product} placeholder={miss.includes('product') ? '— ?' : ''}
                    onSave={(v) => onPatch({ product: v })} />
          <EditCell leadId={l.id} label="size" value={l.size} placeholder={miss.includes('size') ? '— ?' : ''}
                    onSave={(v) => onPatch({ size: v })} />
          <EditCell leadId={l.id} label="finish" value={l.finish} placeholder={miss.includes('finish') ? '— ?' : ''}
                    onSave={(v) => onPatch({ finish: v })} />
          <EditCell leadId={l.id} label="color" value={l.color} placeholder={miss.includes('color') ? '— ?' : ''}
                    onSave={(v) => onPatch({ color: v })} />
        </div>

        <div className="section">What they asked for</div>
        {live && (
          <div className="livebar">
            <span className="k">Live on site</span>
            <span style={{ fontSize: 'var(--text-md)' }}>They are on the site now — type below and they see it in the widget.</span>
          </div>
        )}
        <div className="thread">
          {d.messages.map((m) => (
            <div key={m.id} className={`bubble ${m.direction === 'in' ? 'in' : m.author === 'bot' ? 'bot' : 'out'}`}>
              <span className="who">{m.author === 'visitor' ? who : m.author === 'bot' ? 'Bot' : 'Rep'} · {age(m.sent_at)} ago</span>
              {m.has_audio && (
                <div className="vm">
                  <Voicemail leadId={l.id} messageId={m.id} />
                      <span className="label">
                    {m.transcript_status === 'pending' ? 'Transcribing…'
                      : m.transcript_status === 'failed' ? 'Could not read the audio — listen and fill the spec in by hand'
                      : 'Voicemail · transcript below'}
                  </span>
                </div>
              )}
              {m.body}
            </div>
          ))}
          {!d.messages.length && <div className="empty">No messages yet</div>}
        </div>

        <Files leadId={l.id} files={d.attachments ?? []} />

        <History leadId={l.id} users={users} />
        {error && <p className="err">{error}</p>}
      </div>

      <div className="composer">
        <input value={draft} placeholder={live ? 'Answer in the chat…' : `Reply to ${who}…`}
               onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) { e.preventDefault(); send(); } }} />
        <button className="btn-primary" onClick={send} disabled={sending || !draft.trim()}>
          {live ? 'Send in chat' : sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * Sign in.
 *
 * Password is the only provider implemented, but the org's `auth` column already says which
 * providers a tenant allows, so Microsoft/Google/SAML buttons slot in beside this without
 * changing how sessions work.
 */
function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(email.trim(), password);
      onDone();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <form onSubmit={submit}>
        <span className="eyebrow">Front Desk</span>
        <h1 className="display" style={{ fontSize: 'var(--h2)', margin: '2px 0 10px' }}>Sign in</h1>
        <label className="fb-field">
          <span className="label">Email</span>
          <input type="email" autoComplete="username" autoFocus required
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="fb-field">
          <span className="label">Password</span>
          <input type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <p className="err">{err}</p>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/** Everything that arrived with the job. In a print shop this is usually the job. */
function Files({ leadId, files }: { leadId: string; files: Attachment[] }) {
  if (!files.length) return null;
  const size = (n: number) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

  return (
    <>
      <div className="section">Files</div>
      <ul className="files">
        {files.map((f) => (
          <li key={f.id}>
            {f.r2_key ? (
              <a href={`/api/leads/${leadId}/file/${f.id}?org=${encodeURIComponent(orgSlug)}`}
                 download={f.filename}>{f.filename}</a>
            ) : (
              <span className="files-gone">{f.filename}</span>
            )}
            <i>{size(f.bytes)}</i>
            {/* Recorded with no file: it arrived too large for mail to carry. */}
            {!f.r2_key && <em>too large to attach — ask for a link</em>}
          </li>
        ))}
      </ul>
    </>
  );
}
