// Generated from widget/chat.js — edit that file, then run: npm run build:widget
export const CHAT_JS = `/* Midlayr Chat · drop-in widget · served from cdn.midlayr.com/chat.js
   <script src="https://cdn.midlayr.com/chat.js" data-org="dumont" data-flow="quote-intake" async></script>
   No framework. Reads tenant brand + flow from /widget/config, opens a WebSocket to the ChatSession DO. */
(function () {
  /** Tint a tenant colour toward white — tokens.css derives --accent-tint the same way. */
  function mix(hex, to, amt) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, bl] = p(hex), [r2, g2, b2] = p(to);
    const c = (x, y) => Math.round(x + (y - x) * amt).toString(16).padStart(2, '0');
    return \`#\${c(r, r2)}\${c(g, g2)}\${c(bl, b2)}\`;
  }
  const tag = document.currentScript; const org = tag.dataset.org; const flow = tag.dataset.flow || 'quote-intake';
  // Default to wherever this script came from: on cdn.midlayr.com data-api names the API,
  // but for a Worker serving its own /widget/chat.js the same origin is already correct.
  const API = tag.dataset.api || new URL(tag.src, location.href).origin;
  const vid = localStorage.getItem('ml_vid') || (localStorage.setItem('ml_vid', crypto.randomUUID()), localStorage.getItem('ml_vid'));
  let sid = sessionStorage.getItem('ml_sid');

  fetch(\`\${API}/widget/config?org=\${org}&flow=\${flow}\`)
    .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(\`\${r.status} \${t}\`))))
    .then(boot)
    .catch(e => console.error('[midlayr] widget config failed:', e));

  function boot(cfg) {
    const b = cfg.brand || {}; const w = cfg.widget || {}; const color = b.color || '#0B7FA8'; const ink = b.ink || '#14161A'; const paper = b.paper || '#FBFAF8';
    // The bot has its own short name. BRAND.md and design/ref-widget.png label the bubble
    // "Dumont", not "DUMONT PRINTING" — the wordmark is the header's job, and shouting the
    // full legal name on every turn reads like a form letter. Tenant data, with a sane
    // fallback so a new org needs no extra config.
    const botName = b.bot_name || (cfg.orgName || '').split(/\\s+/)[0] || 'Chat';
    const tint = b.accent_tint || mix(color, '#ffffff', .88);
    let repName = '';
    const root = document.createElement('div'); root.id = 'midlayr-chat'; document.body.appendChild(root);
    const sh = root.attachShadow({ mode: 'open' });
    sh.innerHTML = \`
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,700&family=Inter+Tight:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        :host{all:initial}
        .l{position:fixed;right:28px;bottom:28px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font:14px/1.4 system-ui,sans-serif;z-index:2147483000}
        .nudge{background:\${paper};color:\${ink};border:1px solid #E3E1DC;padding:10px 14px;max-width:260px;box-shadow:0 8px 24px rgba(0,0,0,.1)}
        .btn{background:\${color};color:#fff;border:0;border-radius:2px;padding:12px 18px;font:600 14px system-ui;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.14)}
        .w{position:fixed;right:28px;bottom:28px;width:min(380px,calc(100vw - 56px));height:min(560px,calc(100vh - 56px));display:none;flex-direction:column;background:\${paper};color:\${ink};border:1px solid #E3E1DC;box-shadow:0 12px 32px rgba(0,0,0,.16);font:14px/1.5 'Inter Tight',system-ui,sans-serif;z-index:2147483001}
        .w.open{display:flex}
        .h{display:flex;align-items:center;gap:10px;padding:12px 14px;background:\${ink};color:\${paper};font:700 14px 'Archivo',system-ui;font-variation-settings:'wdth' 125;letter-spacing:.06em;text-transform:uppercase}
        .h .live{font:11px ui-monospace,monospace;text-transform:none;letter-spacing:.04em;color:#9AA0A8}.h .live.on{color:#4FC28A}
        .h button{margin-left:auto;background:none;border:0;color:#9AA0A8;font-size:14px;cursor:pointer}
        .m{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
        .t{max-width:86%;padding:9px 11px;border:1px solid #E3E1DC;background:#F2F1EE;font-size:13.5px}
        .t small{display:block;font:10.5px 'IBM Plex Mono',ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:#9AA0A8;margin-bottom:4px}
        .t.you{align-self:flex-end;background:\${tint};color:\${ink};border-color:\${color}}.t.you small{color:\${color}}
        .t.rep{background:\${paper};border-color:#1F7A4D}.t.rep small{color:#1F7A4D}
        .sys{text-align:center;font:10.5px ui-monospace,monospace;color:#1F7A4D;letter-spacing:.06em}
        .f{border-top:1px solid #E3E1DC;padding:10px 14px 12px}
        .c{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.c:empty{margin:0}
        .c button{border:1px solid \${color};background:\${tint};color:\${color};border-radius:2px;padding:6px 11px;font:13px 'Inter Tight',system-ui;cursor:pointer}
        form{display:flex;gap:8px;align-items:center;border:1px solid #E3E1DC;border-radius:2px;padding:0 10px;height:36px}
        input{flex:1;border:0;outline:0;background:none;font:13.5px system-ui;color:\${ink};min-width:0}
        form button{border:0;background:\${ink};color:\${paper};width:26px;height:26px;border-radius:2px;cursor:pointer}
        .pb{font:10px system-ui;color:#9AA0A8;text-align:right;padding:4px 14px 8px}
      </style>
      <div class="l"><div class="nudge" hidden>\${esc(w.nudge || 'Need a price? Tell me what you\\'re printing.')}</div><button class="btn">\${esc(w.launcher || 'Get a quote')}</button></div>
      <div class="w"><div class="h"><span>\${esc(b.app_name_public || cfg.orgName || '')}</span><span class="live">· quotes</span><button aria-label="Close">✕</button></div>
        <div class="m"></div><div class="f"><div class="c"></div><form><input placeholder="Type your answer" autocomplete="off"><button type="submit">↵</button></form></div>
        \${b.show_powered_by === false ? '' : '<div class="pb">Powered by Midlayr</div>'}</div>\`;
    const $ = s => sh.querySelector(s); const L = $('.l'), W = $('.w'), M = $('.m'), C = $('.c'), F = $('form'), I = $('input'), live = $('.live');
    setTimeout(() => { if (!W.classList.contains('open')) $('.nudge').hidden = false; }, 8000);
    $('.btn').onclick = () => { W.classList.add('open'); L.style.display = 'none'; connect(); };
    $('.h button').onclick = () => { W.classList.remove('open'); L.style.display = ''; };

    let ws;
    function connect() {
      if (ws) return;
      if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem('ml_sid', sid); }
      // The session route resolves the tenant by slug, the same public identifier the
      // script tag carries — never the internal org id.
      const q = new URLSearchParams({ org, flow, sid, vid, role: 'visitor', ref: document.referrer, page: location.pathname, ua: navigator.userAgent });
      ws = new WebSocket(\`\${API.replace(/^http/, 'ws')}/widget/session?\${q}\`);
      ws.onmessage = e => { const m = JSON.parse(e.data);
        if (m.type === 'hello') { M.innerHTML = ''; m.turns.forEach(turn); chips(m.chips); if (m.state === 'live') setLive(); }
        if (m.type === 'turn') { turn(m.turn); chips(m.chips); if (m.state === 'live') setLive(); }
        if (m.type === 'joined') { const d = document.createElement('div'); d.className = 'sys'; d.textContent = \`— \${m.repName} joined the conversation —\`; M.appendChild(d); repName = m.repName || ''; setLive(m.repName); }
        if (m.type === 'ended') { I.placeholder = 'This chat has ended'; I.disabled = true; }
        M.scrollTop = M.scrollHeight; };
      ws.onclose = () => { ws = null; setTimeout(connect, 2000); };
    }
    function turn(t) {
      const d = document.createElement('div');
      d.className = 't ' + (t.who === 'visitor' ? 'you' : t.who);
      // A named human outranks the bot name once a rep has joined.
      const who = t.who === 'visitor' ? 'You'
        : t.who === 'rep' ? (repName || botName)
        : botName;
      d.innerHTML = \`<small>\${esc(who)}</small>\${esc(t.text)}\`;
      M.appendChild(d);
    }
    function chips(list) { C.innerHTML = ''; (list || []).forEach(l => { const b = document.createElement('button'); b.type = 'button'; b.textContent = l; b.onclick = () => send(l); C.appendChild(b); }); }
    function setLive(name) { live.textContent = '● live' + (name ? ' with ' + name : ''); live.classList.add('on'); I.placeholder = 'Reply'; }
    function send(text) { if (!text.trim() || !ws) return; ws.send(JSON.stringify({ type: 'say', text })); I.value = ''; }
    F.onsubmit = e => { e.preventDefault(); send(I.value); };
    let tt; I.oninput = () => { clearTimeout(tt); ws && ws.send(JSON.stringify({ type: 'typing' })); tt = setTimeout(() => {}, 800); };
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
`;
