// Generated from web/console.html — edit that file, then run: npm run build:web
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Front Desk</title>
<style>
  /* Defaults only; applyBrand() overwrites these from GET /api/org so the console wears
     the tenant's colours. Nothing here is specific to any one tenant. */
  :root{--paper:#FBFAF8;--ink:#14161A;--line:#E3E1DC;--mut:#8A9099;--accent:#0B7FA8;--live:#2E9E6B}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .lbl{font:600 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
  header{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--ink);color:var(--paper)}
  header h1{margin:0;font:700 14px system-ui;letter-spacing:.08em;text-transform:uppercase}
  header img{height:26px;width:auto;display:block;background:#fff;padding:3px 7px;border-radius:2px}
  header .dot{width:7px;height:7px;border-radius:50%;background:#C8452F}
  header .dot.on{background:var(--live)}
  header .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
  input,button{font:inherit}
  input{border:1px solid var(--line);padding:7px 9px;background:#fff;color:var(--ink)}
  header input{background:#23262C;border-color:#343841;color:var(--paper);width:230px}
  button{border:1px solid var(--ink);background:var(--ink);color:var(--paper);padding:7px 13px;cursor:pointer}
  button.ghost{background:transparent;color:var(--ink)}
  button:disabled{opacity:.4;cursor:not-allowed}
  main{display:grid;grid-template-columns:330px 1fr;height:calc(100vh - 49px)}
  #queue{border-right:1px solid var(--line);overflow:auto;background:#fff}
  .lead{padding:12px 16px;border-bottom:1px solid var(--line);cursor:pointer}
  .lead:hover{background:#F4F3F0}
  .lead[aria-selected=true]{background:#EFF6F9;box-shadow:inset 3px 0 0 var(--accent)}
  .lead .top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .tno{font:600 12px ui-monospace,monospace;letter-spacing:.04em}
  .pill{font:600 9px ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase;padding:2px 6px;border:1px solid var(--line);color:var(--mut)}
  .pill.live{color:#fff;background:var(--live);border-color:var(--live)}
  .pill.rush{color:#fff;background:#C8452F;border-color:#C8452F}
  .sum{margin-top:5px;color:#444;font-size:13px}
  #pane{display:flex;flex-direction:column;overflow:hidden}
  #spec{display:flex;flex-wrap:wrap;gap:20px;padding:14px 20px;border-bottom:1px solid var(--line);background:#fff}
  #spec div{min-width:74px}
  #spec b{display:block;font-weight:500;font-size:13.5px;margin-top:2px}
  #spec .miss{color:#C8452F;font-style:italic}
  #thread{flex:1;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:9px}
  .t{max-width:66%;padding:8px 11px;border:1px solid var(--line);background:#fff;font-size:13.5px;white-space:pre-wrap}
  .t small{display:block;font:10px ui-monospace,monospace;letter-spacing:.06em;color:var(--mut);margin-bottom:3px}
  .t.in{align-self:flex-start}
  .t.out{align-self:flex-end;background:var(--accent);color:#fff;border-color:var(--accent)}
  .t.out small{color:rgba(255,255,255,.75)}
  .t.bot{align-self:flex-start;background:#F2F1EE}
  #composer{display:flex;gap:8px;padding:12px 20px;border-top:1px solid var(--line);background:#fff}
  #composer input{flex:1}
  #empty{margin:auto;color:var(--mut)}
  .hint{padding:10px 20px;background:#FFF8E5;border-bottom:1px solid #EADFBB;font-size:12.5px}
</style>
</head>
<body>
<header>
  <img id="logo" alt="" hidden>
  <h1 id="appname">Front Desk</h1>
  <span class="dot" id="dot"></span><span class="lbl" id="conn">offline</span>
  <span class="sp">
    <input id="org" placeholder="org slug" value="dumont">
    <input id="user" placeholder="user id">
    <button class="ghost" id="connect" style="border-color:#343841;color:var(--paper)">Connect</button>
  </span>
</header>
<div class="hint" id="hint">Enter a <code>users.id</code> and press Connect. On localhost no token is needed.</div>
<main>
  <div id="queue"></div>
  <div id="pane"><div id="empty">Select a ticket</div></div>
</main>
<script>
const $ = s => document.querySelector(s);
let leads = [], sel = null, chatWs = null, inboxWs = null, brand = {};
const qs = new URLSearchParams(location.search);
if (qs.get('org')) $('#org').value = qs.get('org');
if (qs.get('user')) $('#user').value = qs.get('user');

const base = location.origin;
const orgSlug = () => $('#org').value.trim();
const headers = () => {
  const h = { 'x-dev-user': $('#user').value.trim() };
  const t = sessionStorage.getItem('adminToken');
  if (t) h['x-admin-token'] = t;
  return h;
};
// ?org= is only honoured on localhost; elsewhere the hostname resolves the tenant.
const api = p => \`\${base}\${p}\${p.includes('?') ? '&' : '?'}org=\${encodeURIComponent(orgSlug())}\`;

/** Paint the console in the tenant's brand. Everything comes from the org row. */
async function applyBrand() {
  const r = await fetch(api('/api/org'), { headers: headers() });
  if (!r.ok) return;
  const org = await r.json();
  brand = org.brand || {};
  const root = document.documentElement.style;
  if (brand.color) root.setProperty('--accent', brand.color);
  if (brand.ink) root.setProperty('--ink', brand.ink);
  if (brand.paper) root.setProperty('--paper', brand.paper);
  if (brand.line) root.setProperty('--line', brand.line);
  document.title = brand.app_name || \`\${org.name} · Front Desk\`;
  $('#appname').textContent = brand.app_name || org.name;
  if (brand.logo_url) {
    const img = $('#logo');
    img.src = base + brand.logo_url;   // already carries ?org=
    img.alt = org.name;
    img.hidden = false;
    $('#appname').hidden = true;
  }
}

async function loadQueue() {
  const r = await fetch(api('/api/leads'), { headers: headers() });
  if (!r.ok) { $('#hint').textContent = \`Queue error \${r.status}: \${await r.text()}\`; return; }
  leads = (await r.json()).leads;
  renderQueue();
  $('#hint').style.display = 'none';
}

function renderQueue() {
  $('#queue').innerHTML = leads.map(l => \`
    <div class="lead" data-id="\${l.id}" aria-selected="\${sel === l.id}">
      <div class="top"><span class="tno">\${l.ticket_no}</span>
        <span>\${l.rush ? '<span class="pill rush">rush</span> ' : ''}<span class="pill \${l.status === 'live' ? 'live' : ''}">\${l.status}</span></span>
      </div>
      <div class="sum">\${[l.qty, l.product].filter(Boolean).join(' × ') || '<i style="color:#8A9099">no specs yet</i>'}</div>
      <div class="lbl" style="margin-top:4px">\${l.channel} · \${l.contact_phone || l.contact_email || 'anonymous'}</div>
    </div>\`).join('');
  document.querySelectorAll('.lead').forEach(el => el.onclick = () => openLead(el.dataset.id));
}

async function openLead(id) {
  sel = id; renderQueue();
  const r = await fetch(api(\`/api/leads/\${id}\`), { headers: headers() });
  if (!r.ok) return;
  const d = await r.json();
  const L = d.lead, miss = L.missing_fields || [];
  const cell = (k, v) => \`<div><span class="lbl">\${k}</span><b class="\${!v && miss.includes(k) ? 'miss' : ''}">\${v ?? (miss.includes(k) ? 'missing' : '—')}</b></div>\`;
  $('#pane').innerHTML = \`
    <div id="spec">
      \${cell('product', L.product)}\${cell('qty', L.qty)}\${cell('size', L.size)}
      \${cell('stock', L.stock)}\${cell('color', L.color)}\${cell('finish', L.finish)}
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <span class="pill \${L.status === 'live' ? 'live' : ''}">\${L.status}</span>
        \${L.channel === 'chat' ? \`<button id="take">Take over chat</button>\` : ''}
      </div>
    </div>
    <div id="thread"></div>
    <div id="composer"><input id="msg" placeholder="Reply…"><button id="send">Send</button></div>\`;
  d.messages.forEach(m => addTurn(m.direction === 'in' ? 'in' : (m.author === 'bot' ? 'bot' : 'out'), m.author, m.body));
  $('#send').onclick = send;
  $('#msg').onkeydown = e => { if (e.key === 'Enter') send(); };
  const take = $('#take');
  if (take) take.onclick = () => takeover(id);
  if (L.channel === 'chat') openChatSocket(id);
}

function addTurn(cls, who, text) {
  const t = $('#thread'); if (!t) return;
  const d = document.createElement('div');
  d.className = 't ' + cls;
  d.innerHTML = \`<small>\${who}</small>\${(text ?? '').replace(/</g, '&lt;')}\`;
  t.appendChild(d); t.scrollTop = t.scrollHeight;
}

async function send() {
  const box = $('#msg'), body = box.value.trim(); if (!body) return;
  box.value = '';
  if (chatWs && chatWs.readyState === 1) {
    chatWs.send(JSON.stringify({ type: 'say', text: body, repId: $('#user').value.trim() }));
    return;
  }
  const r = await fetch(api(\`/api/leads/\${sel}/reply\`), {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  addTurn('out', 'you', r.ok ? body : \`send failed: \${await r.text()}\`);
  loadQueue();
}

async function takeover(id) {
  const r = await fetch(api(\`/api/leads/\${id}/takeover\`), { method: 'POST', headers: headers() });
  if (!r.ok) return addTurn('bot', 'system', \`takeover failed: \${await r.text()}\`);
  $('#take').disabled = true; $('#take').textContent = 'You are live';
}

// Sockets carry a one-minute ticket, never the admin token: a secret in a URL ends up in
// logs, proxies and Referer headers.
async function wsUrl(path) {
  const u = new URL(base + path);
  u.protocol = u.protocol.replace('http', 'ws');
  u.searchParams.set('org', orgSlug());
  const r = await fetch(api('/api/ws-ticket'), { method: 'POST', headers: headers() });
  if (r.ok) u.searchParams.set('ticket', (await r.json()).ticket);
  else u.searchParams.set('user', $('#user').value.trim()); // localhost fallback
  return u.toString();
}

async function openChatSocket(leadId) {
  const l = leads.find(x => x.id === leadId);
  if (chatWs) { chatWs.close(); chatWs = null; }
  if (!l || !l.chat_sid) return;
  chatWs = new WebSocket(await wsUrl(\`/api/leads/\${leadId}/chat\`));
  chatWs.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'turn') addTurn(m.turn.who === 'visitor' ? 'in' : (m.turn.who === 'bot' ? 'bot' : 'out'), m.turn.who, m.turn.text);
    if (m.type === 'joined') addTurn('bot', 'system', \`\${m.repName} joined\`);
  };
}

async function connectInbox() {
  if (inboxWs) inboxWs.close();
  inboxWs = new WebSocket(await wsUrl('/api/inbox/stream'));
  inboxWs.onopen = () => { $('#dot').classList.add('on'); $('#conn').textContent = 'live'; };
  inboxWs.onclose = () => { $('#dot').classList.remove('on'); $('#conn').textContent = 'offline'; };
  inboxWs.onmessage = () => loadQueue();
}

$('#connect').onclick = () => {
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && !sessionStorage.getItem('adminToken')) {
    const t = prompt('Admin token (SESSION_SECRET) — this can act as any user, so only paste it on a machine you trust:');
    if (t) sessionStorage.setItem('adminToken', t);
  }
  applyBrand().then(loadQueue).then(connectInbox);
};
// Only auto-connect when we can actually authenticate: on localhost, or once a token is
// stored. Otherwise the first call 401s and races the real one.
const canAuto = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || sessionStorage.getItem('adminToken');
if ($('#user').value && canAuto) $('#connect').click();
</script>
</body>
</html>
`;
