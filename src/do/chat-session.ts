// Durable Object: one per chat session. Holds the visitor socket and (after takeover) the rep socket.
// Runs the published flow (ask steps) server-side; persists turns to Postgres on ticket creation / handoff / end.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import { advance as engineAdvance, asksOf, chipsFor, type FlowState } from '../flow-engine';

type Turn = { who: 'visitor' | 'bot' | 'rep'; text: string; at: number };
type Step = { kind: 'ask'; prompt: string; field: string; chips?: string; skippable?: boolean } | { kind: 'rule'; words: string; handoff: string; route: string } | { kind: 'ticket'; text: string };
type SessionState = { sid: string; orgId: string; flowSlug: string; flowId: string; flowVersion: number; steps: Step[]; stepIdx: number; captured: Record<string, string>; turns: Turn[]; state: 'bot' | 'live' | 'done'; leadId?: string; repId?: string; visitor: Record<string, unknown> };

export class ChatSession extends DurableObject<Env> {
  private s!: SessionState;
  private sockets = new Map<WebSocket, 'visitor' | 'rep'>();

  async fetch(req: Request) {
    const url = new URL(req.url);

    // The rep's "Take over" comes in as a plain POST from the Worker, not a socket.
    if (req.method === 'POST' && url.pathname === '/takeover') {
      if (req.headers.get('x-internal-token') !== this.env.SESSION_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const stored = await this.ctx.storage.get<SessionState>('s');
      if (!stored) return new Response('no such session', { status: 404 });
      this.s ??= stored;
      const { repId, repName } = await req.json<{ repId: string; repName: string }>();
      await this.takeover(repId, repName);
      return Response.json({ ok: true });
    }

    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = (url.searchParams.get('role') as 'visitor' | 'rep') || 'visitor';
    await this.load(url);
    // Every connection, not just a cold one: load() returns early while the object is warm,
    // so a check inside it only ran after an eviction.
    if (role === 'visitor') await this.adoptNewerFlow();
    // Ask the opening question *before* the socket exists, so it travels inside `hello`.
    // Broadcasting it after acceptWebSocket races the 101 handshake and the client misses
    // it; and botAsk alone never persisted, so it was also lost on hibernation.
    if (role === 'visitor' && this.s.turns.length === 0) {
      await this.botAsk();
      await this.save();
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    this.sockets.set(server, role);
    server.send(JSON.stringify({ type: 'hello', state: this.s.state, turns: this.s.turns, captured: this.s.captured, chips: this.chips() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Roles come from the tag passed to acceptWebSocket, not the in-memory map: the DO can
   * hibernate between messages, and on wake `sockets` is empty. Reading the map first meant
   * a reconnected rep was treated as a visitor and could no longer take over or speak.
   */
  private roleOf(ws: WebSocket): 'visitor' | 'rep' {
    const tag = this.ctx.getTags(ws)[0];
    if (tag === 'rep' || tag === 'visitor') return tag;
    return this.sockets.get(ws) ?? 'visitor';
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await this.load(new URL('https://do/'));
    const role = this.roleOf(ws);
    const msg = JSON.parse(String(raw));
    if (msg.type === 'say' && role === 'visitor') return this.visitorSays(msg.text);
    if (msg.type === 'say' && role === 'rep') return this.repSays(msg.text, msg.repId);
    if (msg.type === 'takeover' && role === 'rep') return this.takeover(msg.repId, msg.repName);
    if (msg.type === 'typing') return this.broadcast({ type: 'typing', who: role }, ws);
    if (msg.type === 'end' && role === 'rep') return this.end();
  }
  async webSocketClose(ws: WebSocket) { this.sockets.delete(ws); await this.persist(); }

  // ── flow engine ────────────────────────────────────────
  // Rules live in src/flow-engine.ts so the builder's preview runs exactly this logic.
  private asks() { return asksOf(this.s.steps); }
  private chips() { return chipsFor(this.s.steps, this.s as unknown as FlowState); }
  private async botAsk() { const a = this.asks()[this.s.stepIdx]; if (a) this.push({ who: 'bot', text: a.prompt, at: Date.now() }); }

  /**
   * One visitor message. The decisions — capture, handoff rule, advance, ticket — all come
   * from flow-engine, which is also what /api/flows/:slug/simulate runs, so the builder's
   * preview cannot drift from what actually happens here. This method only does the things
   * the engine cannot: broadcast, create the lead, and notify the inbox.
   */
  private async visitorSays(text: string) {
    if (this.s.state !== 'bot') {
      this.push({ who: 'visitor', text, at: Date.now() });
      await this.save();
      return this.persist();
    }

    const before = this.s.turns.length;
    const r = engineAdvance(this.s.steps, this.s as unknown as FlowState, text);
    this.s.turns = r.next.turns as Turn[];
    this.s.captured = r.next.captured;
    this.s.stepIdx = r.next.stepIdx;
    this.s.state = r.next.state;

    for (const t of this.s.turns.slice(before)) {
      this.broadcast({ type: 'turn', turn: t, captured: this.s.captured, chips: this.chips(), state: this.s.state });
    }

    if (r.handedOff || r.completed) await this.ensureLead();
    if (r.handedOff) await this.notifyInbox('handoff_requested');
    await this.save();
  }

  private async takeover(repId: string, repName: string) {
    await this.ensureLead(); this.s.state = 'live'; this.s.repId = repId;
    this.broadcast({ type: 'joined', repName });
    await this.env.JOBS.send({ kind: 'score_intent', orgId: this.s.orgId, leadId: this.s.leadId! });
    await this.notifyInbox('live'); await this.save();
  }
  private async repSays(text: string, repId: string) {
    this.s.repId = repId;
    this.push({ who: 'rep', text, at: Date.now() });
    await this.save();
    await this.persist();
  }
  private async end() { this.s.state = 'done'; this.broadcast({ type: 'ended' }); await this.persist(); await this.save(); }

  // ── io ─────────────────────────────────────────────────
  private push(t: Turn) { this.s.turns.push(t); this.broadcast({ type: 'turn', turn: t, captured: this.s.captured, chips: this.chips(), state: this.s.state }); }
  private broadcast(o: unknown, except?: WebSocket) { const m = JSON.stringify(o); for (const ws of this.ctx.getWebSockets()) if (ws !== except) try { ws.send(m); } catch {} }
  private async load(url: URL) {
    if (this.s) return;
    const stored = await this.ctx.storage.get<SessionState>('s');
    if (stored) { this.s = stored; return; }
    const orgId = url.searchParams.get('org');
    if (!orgId) throw new Error('chat session not initialised');
    const flowSlug = url.searchParams.get('flow') || 'quote-intake';
    // The DO is addressed with idFromName(sid), so the *name* is what has to be stored as
    // do_id. ctx.id.toString() is the hex id, and idFromName(hex) resolves to a different
    // object entirely — takeover would silently talk to an empty session.
    const sid = url.searchParams.get('sid') ?? this.ctx.id.toString();
    const cfg = await this.env.CONFIG.get<{ id: string; version: number; steps: Step[] }>(`flow:${orgId}:${flowSlug}`, 'json');
    if (!cfg) throw new Error('flow not published');
    this.s = { sid, orgId, flowSlug, flowId: cfg.id, flowVersion: cfg.version, steps: cfg.steps, stepIdx: 0, captured: {}, turns: [], state: 'bot', visitor: { referrer: url.searchParams.get('ref'), landing: url.searchParams.get('page'), ua: url.searchParams.get('ua') } };
    await this.save();
  }
  private save() { return this.ctx.storage.put('s', this.s); }

  /**
   * A visitor's session id lives in sessionStorage, so it outlives a publish — left alone,
   * anyone who opened the widget before the change keeps replaying the old script until they
   * close the tab, which looks exactly like "publish did nothing".
   *
   * So pick up a newer published version, but only while the conversation has not really
   * started: swapping the questions out from under someone mid-answer would strand them on a
   * step that no longer exists and lose what they had already told us.
   */
  private async adoptNewerFlow() {
    // A rep is on the line: never touch the script underneath them.
    if (this.s.state === 'live') return;

    const last = this.s.turns[this.s.turns.length - 1]?.at ?? 0;
    const idleMs = Date.now() - last;
    const barelyStarted = this.s.turns.length <= 1;
    const finished = this.s.state === 'done';
    const abandoned = idleMs > 30 * 60 * 1000;   // came back later; this is a new enquiry

    // Mid-answer and still warm — resuming beats restarting, even on an older script.
    if (!barelyStarted && !finished && !abandoned) return;

    const slug = this.s.flowSlug || 'quote-intake';
    const cfg = await this.env.CONFIG.get<{ id: string; version: number; steps: Step[] }>(
      `flow:${this.s.orgId}:${slug}`, 'json');
    if (!cfg || cfg.version === this.s.flowVersion) return;

    this.s.flowId = cfg.id;
    this.s.flowVersion = cfg.version;
    this.s.steps = cfg.steps;
    this.s.stepIdx = 0;
    this.s.captured = {};
    this.s.turns = [];   // cleared so the new opening question is asked on connect
    await this.save();
  }
  private async ensureLead() {
    if (this.s.leadId) return;
    // Worker-side helper does the INSERT (contact by captured.contact, lead channel='chat', chat_sessions row) and returns leadId
    const r = await this.env.INTERNAL.fetch('https://internal/internal/leads/from-chat', {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify({ orgId: this.s.orgId, sessionId: this.s.sid, captured: this.s.captured, visitor: this.s.visitor, flowId: this.s.flowId, flowVersion: this.s.flowVersion }),
    });
    if (!r.ok) throw new Error(`from-chat failed: ${r.status} ${await r.text()}`);
    this.s.leadId = (await r.json() as { leadId: string }).leadId;
    // Flush the turns first: extract_specs reads messages, and enqueuing before the write
    // meant the job ran against an empty transcript and silently found nothing.
    await this.persist();
    await this.env.JOBS.send({ kind: 'extract_specs', orgId: this.s.orgId, leadId: this.s.leadId });
  }
  private internalHeaders() {
    return { 'content-type': 'application/json', 'x-internal-token': this.env.SESSION_SECRET };
  }

  private async persist() {
    if (!this.s?.leadId) return;
    await this.env.INTERNAL.fetch('https://internal/internal/leads/chat-turns', {
      method: 'POST',
      headers: this.internalHeaders(),
      body: JSON.stringify({ orgId: this.s.orgId, leadId: this.s.leadId, sessionId: this.s.sid, turns: this.s.turns, state: this.s.state, captured: this.s.captured }),
    });
  }
  private async notifyInbox(kind: string) { const room = this.env.INBOX_ROOM.get(this.env.INBOX_ROOM.idFromName(this.s.orgId)); await room.fetch('https://do/push', { method: 'POST', body: JSON.stringify({ kind, leadId: this.s.leadId, sessionId: this.s.sid, captured: this.s.captured, state: this.s.state }) }); }
}
