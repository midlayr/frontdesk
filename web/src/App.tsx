import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, applyBrand, getToken, orgSlug, setToken, userId, type Lead, type Message, type Org } from './api';

const VIEWS = ['All', 'New', 'Mine', 'Rush', 'Needs info', 'Quoted', 'Won', 'Lost', 'Spam'] as const;
type View = (typeof VIEWS)[number];

const STATUS_OF: Partial<Record<View, string>> = {
  New: 'new', 'Needs info': 'needs_info', Quoted: 'quoted', Won: 'won', Lost: 'lost', Spam: 'spam',
};

const CHANNEL_TAG: Record<string, string> = { sms: 'SM', voice: 'VM', email: 'EM', form: 'WF', chat: 'CB' };

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
  if (v === 'All') return true;
  if (v === 'Rush') return l.rush;
  if (v === 'Mine') return l.assignee_id === userId;
  return l.status === STATUS_OF[v];
}

export function App() {
  const [org, setOrg] = useState<Org | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [error, setError] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [view, setView] = useState<View>('All');
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ lead: Lead; messages: Message[] } | null>(null);
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const chatWs = useRef<WebSocket | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { leads } = await api.leads();
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

  // realtime queue: InboxRoom pushes on new leads and chat events
  useEffect(() => {
    if (!org) return;
    let ws: WebSocket | null = null;
    let stop = false;
    (async () => {
      try {
        ws = await api.socket('/api/inbox/stream');
        if (stop) return ws.close();
        ws.onmessage = () => refresh();
      } catch { /* queue still works without push */ }
    })();
    return () => { stop = true; ws?.close(); };
  }, [org, refresh]);

  const openLead = useCallback(async (id: string) => {
    setSelId(id);
    setLive(false);
    chatWs.current?.close();
    chatWs.current = null;
    const d = await api.lead(id);
    setDetail({ lead: d.lead, messages: d.messages });

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

  async function takeover() {
    if (!detail) return;
    try {
      await api.takeover(detail.lead.id);
      setLive(true);
      await openLead(detail.lead.id);
      await refresh();
    } catch (e) { setError(String(e)); }
  }

  if (needToken) return <TokenGate onDone={() => { setNeedToken(false); location.reload(); }} />;

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
          <button aria-current="true">Inbox</button>
          <button title="Not built yet">Campaigns</button>
          <button title="Not built yet">Website chat</button>
          <button title="Not built yet">Order form</button>
        </nav>
        <div className="search">
          <input placeholder="Search leads" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="counts">{counts.new} new · {counts.rush} rush</span>
      </header>

      <div className="panes">
        <aside className="rail">
          <span className="eyebrow">Views</span>
          {VIEWS.map((v) => (
            <button key={v} aria-current={view === v} onClick={() => setView(v)}>
              <span>{v}</span>
              <span>{v === 'All' ? leads.length : leads.filter((l) => matches(l, v)).length}</span>
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
          {groups.map((g) => (
            <div key={g.title}>
              <div className="qgroup">{g.title}</div>
              {g.rows.map((l) => {
                const s = summarise(l);
                return (
                  <button key={l.id} className={`row${l.status === 'live' ? ' live' : ''}`}
                          aria-selected={selId === l.id} onClick={() => openLead(l.id)}>
                    <div className="r1">
                      <span className={`dot${l.status === 'live' ? ' ok' : ''}`} />
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
                  send={send} sending={sending} takeover={takeover} error={error} />
        ) : (
          <div className="ticket"><div className="empty">{error || 'Select a ticket'}</div></div>
        )}
      </div>
      <div ref={threadEnd} />
    </div>
  );
}

function SpecCell({ k, v, missing }: { k: string; v: string | number | null; missing: boolean }) {
  return (
    <div className="scell">
      <span className="label">{k}</span>
      <span className={`val${v == null ? ' missing' : ''}`}>{v ?? (missing ? '— ?' : '—')}</span>
    </div>
  );
}

function Ticket({ d, live, draft, setDraft, send, sending, takeover, error }: {
  d: { lead: Lead; messages: Message[] }; live: boolean; draft: string;
  setDraft: (s: string) => void; send: () => void; sending: boolean;
  takeover: () => void; error: string;
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
          <span style={{ marginLeft: 'auto' }} className="tag">{l.status}</span>
          {isChat && !live && <button className="btn-primary" onClick={takeover}>Take over chat</button>}
          {live && <span className="tag live">You are live</span>}
        </div>

        <h1 className="tname">{who}</h1>
        <div className="meta">
          {[l.channel, l.contact_phone, l.contact_email].filter(Boolean).join(' · ').toUpperCase()}
        </div>

        <div className="section">Spec</div>
        <div className="spec">
          <SpecCell k="qty" v={l.qty} missing={miss.includes('qty')} />
          <SpecCell k="stock" v={l.stock} missing={miss.includes('stock')} />
          <SpecCell k="product" v={l.product} missing={miss.includes('product')} />
          <SpecCell k="size" v={l.size} missing={miss.includes('size')} />
          <SpecCell k="finish" v={l.finish} missing={miss.includes('finish')} />
          <SpecCell k="color" v={l.color} missing={miss.includes('color')} />
          <SpecCell k="rush" v={l.rush ? 'yes' : 'no'} missing={false} />
          <SpecCell k="deadline" v={l.deadline_at ? new Date(l.deadline_at).toDateString() : null} missing={false} />
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
              {m.body}
            </div>
          ))}
          {!d.messages.length && <div className="empty">No messages yet</div>}
        </div>
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

/** Off localhost the API needs the operator token. It stays in sessionStorage only. */
function TokenGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState(getToken());
  return (
    <div className="gate">
      <form onSubmit={(e) => { e.preventDefault(); setToken(v.trim()); onDone(); }}>
        <span className="eyebrow">Front Desk · {orgSlug}</span>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-2)', margin: 0 }}>
          This deployment has no user sessions yet. Paste the operator token (SESSION_SECRET).
          It can act as any user in any tenant, so only use it on a machine you trust.
        </p>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="SESSION_SECRET"
               style={{ height: 'var(--control-h)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '0 11px' }} />
        <button className="btn-primary" type="submit">Open Front Desk</button>
      </form>
    </div>
  );
}
