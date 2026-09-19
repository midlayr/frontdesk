// Durable Object: one per org. Every open Front Desk tab holds a socket here; new leads, status changes,
// and live-chat events fan out to all of them. Chat sessions and queue jobs POST /push to it.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';

export class InboxRoom extends DurableObject<Env> {
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/push' && req.method === 'POST') {
      const m = await req.text();
      for (const ws of this.ctx.getWebSockets()) try { ws.send(m); } catch {}
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    // reps send presence / "viewing lead X" so others see who's on a ticket
    const m = JSON.parse(String(raw));
    if (m.type === 'presence') for (const o of this.ctx.getWebSockets()) if (o !== ws) o.send(JSON.stringify(m));
  }
}
