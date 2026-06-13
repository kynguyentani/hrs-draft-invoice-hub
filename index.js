const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.set('trust proxy', true);

const PORT = Number(process.env.PORT) || 9090;
const SETTINGS_FILE = path.join(__dirname, 'app-settings.json');
const SESSION_COOKIE = 'hrs_admin_session';
const ADMIN = { username: 'hrsadmin', password: 'hrsadmin101', displayName: 'Administrator' };
const DEFAULTS = {
  parameters: { clientSecret: '', clientId: '', username: '', password: '' },
  controls: { allowDuplicateBill: false, allowZeroRevVatBill: true }
};

const invoices = new Map();
const sessions = new Map();
const apiTokens = new Map();
const dashboardClients = new Set();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const arr = (v) => !v ? [] : Array.isArray(v) ? v : [v];
const first = (...v) => v.find(x => x !== undefined && x !== null && x !== '');
const num = (...v) => {
  const n = parseFloat(first(...v));
  return Number.isFinite(n) ? n : 0;
};
const fmt = (v, d = 0) => num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const safeJson = (v) => JSON.stringify(v).replace(/<\/script>/gi, '<\\/script>');

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
function normalizeSettings(raw) {
  const d = cloneDefaults();
  const p = raw?.parameters || {};
  const c = raw?.controls || {};
  d.parameters.clientSecret = String(first(p.clientSecret, p.client_secret, '') || '');
  d.parameters.clientId = String(first(p.clientId, p.client_id, '') || '');
  d.parameters.username = String(first(p.username, '') || '');
  d.parameters.password = String(first(p.password, '') || '');
  d.controls.allowDuplicateBill = Boolean(first(c.allowDuplicateBill, c.allow_duplicate_bill, false));
  d.controls.allowZeroRevVatBill = Boolean(first(c.allowZeroRevVatBill, c.allow_zero_rev_vat_bill, true));
  return d;
}
function loadSettings() {
  try { return fs.existsSync(SETTINGS_FILE) ? normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))) : cloneDefaults(); }
  catch { return cloneDefaults(); }
}
let settings = loadSettings();
function saveSettings(next) {
  settings = normalizeSettings(next);
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, req, value, maxAge) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.floor(maxAge / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}
function clearCookie(res, req) { setCookie(res, req, '', 0); }
function getSession(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) { sessions.delete(token); return null; }
  return { token, ...session };
}
function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: ADMIN.username, displayName: ADMIN.displayName, createdAt: Date.now() });
  return token;
}

function notify(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  dashboardClients.forEach(client => client.write(data));
}
function getToken(req) {
  const h = req.get('authorization') || '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}
function validApiToken(req) {
  const now = Date.now();
  for (const [k, v] of apiTokens.entries()) if (now - v.issuedAt > 24 * 60 * 60 * 1000) apiTokens.delete(k);
  return apiTokens.has(getToken(req));
}
function newApiToken() {
  const token = crypto.randomBytes(30).toString('hex');
  apiTokens.set(token, { issuedAt: Date.now() });
  return token;
}
function authPayload() {
  return { StatusCode: 401, IsError: true, Message: 'Please check Parameters!', Result: 'Error! Please check message 401!', ErrorCode: 401 };
}
function serverPayload() {
  return { StatusCode: 500, IsError: true, Message: 'Einvoice Server Error! Contact Einvoice Admin!', Result: 'Einvoice Server Error! Contact Einvoice Admin!', ErrorCode: 500 };
}
function creds(input) {
  return {
    clientSecret: String(first(input?.client_secret, input?.clientSecret, '') || ''),
    clientId: String(first(input?.client_id, input?.clientId, '') || ''),
    username: String(first(input?.username, '') || ''),
    password: String(first(input?.password, '') || '')
  };
}
function configReady() {
  const p = settings.parameters;
  return Boolean(p.clientSecret && p.clientId && p.username && p.password);
}
function credsMatch(input) {
  const a = creds(input), b = settings.parameters;
  return a.clientSecret === b.clientSecret && a.clientId === b.clientId && a.username === b.username && a.password === b.password;
}

const billNo = (d) => first(d?.FolioDeliveryInfo?.BillNo, d?.DocumentInfo?.BillNo, d?.FolioInfo?.FolioHeaderInfo?.BillNo);
const hotelCode = (d) => first(d?.HotelInfo?.HotelCode, d?.FolioDeliveryInfo?.HotelCode, d?.DocumentInfo?.HotelCode);
const roomNo = (d) => first(d?.FolioDeliveryInfo?.RoomNo, d?.FolioDeliveryInfo?.RoomNumber, d?.ReservationInfo?.RoomNumber, d?.FolioInfo?.ReservationInfo?.RoomNumber);
const summary = (d) => {
  const s = d?.FolioSummaryInfo || d?.TotalInfo || d?.FolioInfo?.TotalInfo || {};
  return {
    TotalNet: num(s.TotalNet, s.NetAmount),
    TotalGross: num(s.TotalGross, s.GrossAmount),
    TotalVat8: num(s.TotalVat8, s.TotalVAT8),
    TotalVat10: num(s.TotalVat10, s.TotalVAT10),
    TotalVat5: num(s.TotalVat5, s.TotalVAT5),
    TotalRounding: num(s.TotalRounding),
    TotalTip: num(s.TotalTip, s.TotalTIP)
  };
};
const postings = (d) => arr(d?.FolioPostingDetails || d?.Postings?.Posting || d?.FolioInfo?.Postings).filter(x => x && x.HRSAmount != null);
function paymentTotal(d) {
  return arr(d?.RevenueBucketInfo || d?.FolioInfo?.RevenueBucketInfo).reduce((t, b) => t + (String(b?.BucketType || '').toUpperCase() === 'FLIP_PAY_TYPE' ? num(b?.BucketCodeTotalGross) : 0), 0);
}
function chequeInfo(d) {
  const list = [], map = {}, seen = new Set();
  const add = (no, raw, alias = []) => {
    if (!no || !raw) return;
    const n = String(no), r = String(Array.isArray(raw) ? raw[0] : raw);
    if (!seen.has(n)) { seen.add(n); list.push({ no: n, raw }); }
    [n, ...alias].filter(Boolean).forEach(k => { map[String(k)] = r; });
  };
  arr(d?.FolioInfo?.PosChequeInfo || d?.PosChequeInfo).forEach(c => add(c?.ChequeNo || c?.CheckNo || c?.TrxNo, c?.ChequeDetails, [c?.CheckNo, c?.TrxNo]));
  postings(d).forEach(p => { if (String(p?.ChequeDetails || '').trim()) add(p.ChequeNumber || p.CheckNo || p.ChequeNo || p.TrxNo, p.ChequeDetails, [p.ChequeNumber, p.TrxNo]); });
  return { list, map };
}
function decodeCheque(raw) {
  const value = String(raw || '');
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    if (parsed.ReceiptText) return Buffer.from(parsed.ReceiptText, 'base64').toString('utf8');
    if (parsed.ChequeDetails) return Buffer.from(String(Array.isArray(parsed.ChequeDetails) ? parsed.ChequeDetails[0] : parsed.ChequeDetails), 'base64').toString('utf8');
    return JSON.stringify(parsed, null, 2);
  } catch {
    try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return value; }
  }
}
function entries() {
  return Array.from(invoices.entries()).map(([cacheKey, rec]) => ({ cacheKey, billNo: rec.billNo || cacheKey, timestamp: rec.timestamp, data: rec.data }));
}
function findEntry(key) {
  const k = String(key);
  if (invoices.has(k)) { const rec = invoices.get(k); return { cacheKey: k, billNo: rec.billNo || k, timestamp: rec.timestamp, data: rec.data }; }
  return entries().find(e => e.billNo === k) || null;
}

function layout({ title, body, nav = 'home', session, login = false }) {
  const shell = login ? '' : `
  <div class="app">
    <aside class="side">
      <div class="brand"><div class="logo">HRS</div><div><strong>HRS Draft Invoice Hub</strong><span>Invoice Endpoint Admin Portal</span></div></div>
      <nav class="nav">
        <a class="${nav === 'home' ? 'on' : ''}" href="/">Home</a>
        <a class="${nav === 'reports' ? 'on' : ''}" href="/reports">Reports</a>
        <a class="${nav === 'settings' ? 'on' : ''}" href="/settings">Settings</a>
      </nav>
    </aside>
    <main class="main">
      <header class="top">
        <div><h1>HRS Draft Invoice Hub</h1><span>Invoice Endpoint Admin Portal</span></div>
        <div class="top-right"><em>Live System</em><b>${esc(session?.displayName || '')}</b><small>${esc(session?.username || '')}</small></div>
      </header>
      <section class="wrap">${body}</section>
    </main>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#07111a;--panel:#0f1b29;--panel2:#122131;--line:#22384e;--txt:#edf4fb;--soft:#9bb0c6;--cyan:#34d8e7;--green:#4ade9b;--amber:#f4c04c;--danger:#ff6d80;--mono:Consolas,monospace;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07111a,#05101a);color:var(--txt);font-family:var(--font)}a{text-decoration:none;color:inherit}svg{display:block}button,input{font:inherit}
  .app{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{padding:24px 16px;background:#0a1520;border-right:1px solid rgba(255,255,255,.06)}.brand{display:flex;gap:12px;align-items:center;padding:8px}.logo{display:grid;place-items:center;width:54px;height:54px;border:1px solid rgba(52,216,231,.45);border-radius:16px;color:var(--cyan);font:800 25px var(--mono)}.brand strong,.top h1{display:block;margin:0;font-size:15px;text-transform:uppercase}.brand span,.top span{display:block;margin-top:4px;color:var(--cyan);font:700 11px var(--mono);letter-spacing:.12em;text-transform:uppercase}
  .nav{display:grid;gap:8px;margin-top:16px}.nav a{padding:14px 16px;border-radius:14px;color:var(--soft);border:1px solid transparent}.nav a.on,.nav a:hover{background:rgba(52,216,231,.08);border-color:rgba(52,216,231,.18);color:var(--txt)}
  .top{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:22px 26px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(7,17,26,.85)}.top-right{display:grid;justify-items:end}.top-right em{font:800 12px var(--mono);color:var(--green);font-style:normal;text-transform:uppercase}.top-right b{margin-top:6px}.top-right small{color:var(--soft)}
  .wrap{padding:26px}.hero h2{margin:0;font-size:34px}.hero p{margin:10px 0 0;color:var(--soft)}
  .grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:18px 0}.card,.panel{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid rgba(255,255,255,.07);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.22)}.card{padding:20px}.lab{color:var(--soft);font:700 12px var(--mono);text-transform:uppercase}.val{margin-top:10px;font-size:28px;font-weight:800}
  .panel .head{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:22px;border-bottom:1px solid rgba(255,255,255,.06)}.title{font-size:22px;font-weight:800}.sub{margin-top:6px;color:var(--soft);font-size:14px}.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .badge,.chip{display:inline-flex;align-items:center;justify-content:center;padding:0 14px;min-height:38px;border-radius:12px;border:1px solid rgba(52,216,231,.2);background:rgba(52,216,231,.08);color:#a6fbff;font:800 12px var(--mono);text-transform:uppercase}.chip{min-height:28px;padding:0 10px;border-radius:999px;border-color:rgba(74,222,155,.2);background:rgba(74,222,155,.12);color:var(--green)}
  .btn{height:42px;padding:0 15px;border-radius:14px;border:1px solid transparent;background:rgba(255,255,255,.04);color:var(--txt);cursor:pointer}.btn:hover{background:rgba(255,255,255,.07)}.primary{background:linear-gradient(135deg,#34d8e7,#24bfd0);color:#04202a;font-weight:800}.danger{background:rgba(255,109,128,.08);border-color:rgba(255,109,128,.2);color:#ff9cab}
  .table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1120px}th,td{padding:16px;border-bottom:1px solid rgba(255,255,255,.06)}th{color:var(--soft);font:700 12px var(--mono);text-transform:uppercase;text-align:left}.num{text-align:right;font-variant-numeric:tabular-nums}tr.sel{background:rgba(52,216,231,.07)}
  .bill{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:14px;border:1px solid rgba(52,216,231,.18);background:rgba(255,255,255,.03);font-weight:800}.bill:hover{background:rgba(52,216,231,.08)}.time{display:flex;align-items:center;gap:10px;color:var(--soft)}.dot{width:10px;height:10px;border-radius:50%;background:var(--cyan);box-shadow:0 0 0 4px rgba(52,216,231,.12)}.del{display:grid;place-items:center;width:40px;height:40px;border-radius:14px;border:1px solid rgba(255,109,128,.2);background:rgba(255,109,128,.08);color:#ff9cab}
  .empty{padding:60px 24px;text-align:center;color:var(--soft)}.empty strong{display:block;color:var(--txt);font-size:20px;margin-bottom:8px}
  .login{display:grid;place-items:center;min-height:100vh;padding:28px;background:linear-gradient(rgba(4,10,15,.72),rgba(4,10,15,.82)),radial-gradient(circle at right center,rgba(52,216,231,.18),transparent 35%),#08121b}.login-card{width:min(560px,100%);padding:36px;background:linear-gradient(180deg,#142232,#0f1926);border:1px solid rgba(52,216,231,.24);border-radius:28px}.login-card h2{margin:0;text-align:center;font-size:44px}.login-card .logo{margin:0 auto 24px;width:96px;height:96px;font-size:40px}.login-sub{text-align:center;margin:12px 0 26px;color:var(--cyan);font:800 14px var(--mono);text-transform:uppercase;letter-spacing:.12em}.field{display:grid;gap:8px;margin:0 0 16px}.field label{color:var(--soft);font-weight:700}.in{height:58px;padding:0 16px;border-radius:16px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.22);color:var(--txt);font-size:18px}.err{margin-bottom:16px;padding:13px 15px;border-radius:14px;background:rgba(255,109,128,.09);border:1px solid rgba(255,109,128,.24);color:#ffb7c0}
  .settings{display:grid;gap:16px}.box{padding:22px}.box h3{margin:0 0 8px;font-size:22px}.box p{margin:0 0 18px;color:var(--soft)}.toggle{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px;border-radius:16px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}.switch{position:relative;display:inline-block;width:56px;height:32px}.switch input{opacity:0;width:0;height:0}.slider{position:absolute;inset:0;border-radius:999px;background:#244059}.slider:before{content:"";position:absolute;left:4px;top:4px;width:24px;height:24px;border-radius:50%;background:#fff;transition:.2s}.switch input:checked+.slider{background:#28c8d9}.switch input:checked+.slider:before{transform:translateX(24px)}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;padding:12px 18px;border-radius:14px;background:#1a2430;border:1px solid rgba(255,255,255,.08);transition:.2s}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}.toast.err{color:#ffb7c0;border-color:rgba(255,109,128,.28)}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--soft);font:13px/1.55 var(--mono)}
  @media (max-width:980px){.app{grid-template-columns:1fr}.side{display:none}.top{padding:18px;flex-wrap:wrap}.wrap{padding:18px}.hero h2{font-size:28px}}
  </style></head><body>${login ? body : shell}<div id="toast" class="toast"></div><script>function toast(m,e){const t=document.getElementById('toast');if(!t)return;t.textContent=m;t.className='toast show'+(e?' err':'');clearTimeout(window.__t);window.__t=setTimeout(()=>t.className='toast',2600)}</script></body></html>`;
}

function loginPage(error = '') {
  return layout({
    title: 'Login - HRS Draft Invoice Hub',
    login: true,
    body: `<div class="login"><form class="login-card" method="post" action="/login"><div class="logo">HRS</div><h2>HRS Draft Invoice Hub</h2><div class="login-sub">Administrator Access</div>${error ? `<div class="err">${esc(error)}</div>` : ''}<div class="field"><label>Username</label><input class="in" name="username" value="hrsadmin"></div><div class="field"><label>Password</label><input class="in" type="password" name="password" value="hrsadmin101"></div><button class="btn primary" style="width:100%;height:60px;font-size:22px;margin-top:8px">Sign In</button></form></div>`
  });
}

function rowsHtml(list) {
  if (!list.length) return `<tr><td colspan="13" class="empty"><strong>Waiting for draft invoices</strong><span>New connector transactions will appear here automatically.</span></td></tr>`;
  return list.map(e => {
    const s = summary(e.data), chequeCount = chequeInfo(e.data).list.length;
    return `<tr data-bill="${esc(e.cacheKey)}"><td><input type="checkbox" class="selbox" value="${esc(e.cacheKey)}"></td><td><div class="time"><span class="dot"></span><span>${esc(e.timestamp)}</span></div></td><td style="color:var(--cyan);font-weight:800">${esc(hotelCode(e.data))}</td><td>${esc(roomNo(e.data))}</td><td><a class="bill" href="/invoice/${encodeURIComponent(e.cacheKey)}">${esc(e.billNo)} <span style="color:var(--soft)">↗</span></a>${chequeCount ? ` <a class="chip" href="/invoice/${encodeURIComponent(e.cacheKey)}/cheques">${chequeCount}</a>` : ''}</td><td class="num">${fmt(s.TotalNet)}</td><td class="num">${fmt(s.TotalVat8)}</td><td class="num">${fmt(s.TotalVat10)}</td><td class="num">${fmt(s.TotalVat5)}</td><td class="num" style="color:var(--green);font-weight:800">${fmt(s.TotalGross)}</td><td class="num" style="color:var(--amber);font-weight:800">${fmt(paymentTotal(e.data))}</td><td class="num">${fmt(s.TotalRounding)}</td><td><button class="del" type="button" onclick="delBills(['${encodeURIComponent(e.cacheKey)}'])">✕</button></td></tr>`;
  }).join('');
}

function homePage(session) {
  const list = entries().sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
  const last = list[0]?.timestamp || 'Waiting for data';
  return layout({
    title: 'Home - HRS Draft Invoice Hub',
    nav: 'home',
    session,
    body: `<div class="hero"><h2>Live Draft Invoice Transactions</h2><p>Real-time feed of invoices received via API endpoint.</p></div>
    <div class="grid cards"><div class="card"><div class="lab">Total Invoices</div><div class="val" id="metricCount">${list.length}</div></div><div class="card"><div class="lab">Last Update</div><div class="val">${esc(last)}</div></div><div class="card"><div class="lab">Selected</div><div class="val" id="selectedCount">0</div></div></div>
    <section class="panel"><div class="head"><div><div class="title">Live Transactions</div><div class="sub">Authenticated dashboard view</div></div><div class="tools"><span class="badge" id="recordBadge">${list.length} record${list.length === 1 ? '' : 's'}</span><button id="bulkDeleteBtn" class="btn danger" hidden onclick="bulkDelete()">Delete Selected</button></div></div><div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="all"></th><th>Time Received</th><th>Hotel</th><th>Room</th><th>Bill Number</th><th class="num">Total Net</th><th class="num">VAT 8%</th><th class="num">VAT 10%</th><th class="num">VAT 5%</th><th class="num">Total Gross</th><th class="num">Total Payment</th><th class="num">Rounding</th><th>Action</th></tr></thead><tbody id="rows">${rowsHtml(list)}</tbody></table></div></section>
    <script>
    const all=document.getElementById('all'),bulk=document.getElementById('bulkDeleteBtn'),sc=document.getElementById('selectedCount');
    function boxes(){return Array.from(document.querySelectorAll('.selbox'))}
    function sync(){const b=boxes(),sel=b.filter(x=>x.checked);sc.textContent=String(sel.length);bulk.hidden=!sel.length;all.checked=b.length&&sel.length===b.length;document.querySelectorAll('tbody tr[data-bill]').forEach(r=>{const c=r.querySelector('.selbox');r.classList.toggle('sel',!!c&&c.checked)})}
    function selected(){return boxes().filter(x=>x.checked).map(x=>decodeURIComponent(x.value))}
    async function delBills(bills){const r=await fetch('/api/invoices',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({billNos:bills})});const j=await r.json();if(!r.ok||j.IsError)return toast(j.Message||'Delete failed',true);window.location.reload()}
    function bulkDelete(){const bills=selected();if(!bills.length)return;if(!confirm('Delete selected invoices?'))return;delBills(bills)}
    all&&all.addEventListener('change',e=>{boxes().forEach(x=>x.checked=e.target.checked);sync()});document.addEventListener('change',e=>{if(e.target.matches('.selbox'))sync()});sync();const es=new EventSource('/api/dashboard/events');es.onmessage=()=>window.location.reload();
    </script>`
  });
}

function reportsPage(session) {
  return layout({ title: 'Reports - HRS Draft Invoice Hub', nav: 'reports', session, body: `<div class="hero"><h2>Reports</h2><p>Reserved for future reporting modules.</p></div><section class="panel"><div class="head"><div><div class="title">Coming Later</div><div class="sub">This section will be developed when report definitions are ready.</div></div></div></section>` });
}

function settingsPage(session) {
  return layout({
    title: 'Settings - HRS Draft Invoice Hub',
    nav: 'settings',
    session,
    body: `<div class="hero"><h2>System Settings</h2><p>Secure the endpoint and control invoice validation behavior.</p></div>
    <div class="settings">
      <section class="panel box"><h3>Parameters</h3><p>These values must match the token request and invoice import request.</p>
        <div class="field"><label>Client Secret</label><input id="clientSecret" class="in" type="password" value="${esc(settings.parameters.clientSecret)}"></div>
        <div class="field"><label>Client Id</label><input id="clientId" class="in" value="${esc(settings.parameters.clientId)}"></div>
        <div class="field"><label>Username</label><input id="apiUsername" class="in" value="${esc(settings.parameters.username)}"></div>
        <div class="field"><label>Password</label><input id="apiPassword" class="in" type="password" value="${esc(settings.parameters.password)}"></div>
      </section>
      <section class="panel box"><h3>Controls</h3><p>Apply business rules immediately without restarting the server.</p>
        <div class="toggle"><div><strong>Allow duplicate bill</strong><div class="sub">Off by default.</div></div><label class="switch"><input id="allowDuplicateBill" type="checkbox" ${settings.controls.allowDuplicateBill ? 'checked' : ''}><span class="slider"></span></label></div>
        <div class="toggle" style="margin-top:12px"><div><strong>Allow zero Rev/VAT bill</strong><div class="sub">On by default.</div></div><label class="switch"><input id="allowZeroRevVatBill" type="checkbox" ${settings.controls.allowZeroRevVatBill ? 'checked' : ''}><span class="slider"></span></label></div>
        <div style="margin-top:18px;display:flex;gap:10px"><button class="btn primary" onclick="saveCfg()">Save</button><form method="post" action="/logout"><button class="btn" type="submit">Sign Out</button></form></div>
      </section>
    </div>
    <script>
    async function saveCfg(){const payload={parameters:{clientSecret:clientSecret.value.trim(),clientId:clientId.value.trim(),username:apiUsername.value.trim(),password:apiPassword.value},controls:{allowDuplicateBill:allowDuplicateBill.checked,allowZeroRevVatBill:allowZeroRevVatBill.checked}};const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();toast(j.Message||'Saved',!r.ok||j.IsError)}
    </script>`
  });
}

function groupedRows(list) {
  if (!list.some(p => {
    const x = String(p?.TrxNoAgainstPackage ?? '').trim();
    return x && x !== '0';
  })) return null;
  const pkg = new Map(), solo = [];
  list.forEach(p => {
    const key = String(p?.TrxNoAgainstPackage ?? '').trim();
    if (key && key !== '0') {
      const k = `${key}||${first(p.HRSTaxRate, '')}`;
      if (!pkg.has(k)) pkg.set(k, []);
      pkg.get(k).push(p);
    } else solo.push(p);
  });
  const g = [];
  pkg.forEach(children => g.push({
    __grouped: true,
    Description: 'PACKAGE',
    TrxDate: children[0].TrxDate,
    HRSTaxRate: children[0].HRSTaxRate,
    Quantity: 1,
    HRSAmount: children.reduce((t, c) => t + num(c.HRSAmount), 0),
    ChequeNumber: first(children[0].ChequeNumber, children[0].CheckNo, children[0].ChequeNo, children[0].TrxNo, '')
  }));
  return [...g, ...solo];
}
function postingTable(list, grouped) {
  return list.map((p, i) => {
    const amount = num(p.HRSAmount), qty = num(p.Quantity || 1) || 1, unit = qty ? amount / qty : amount;
    return `<tr${grouped && p.__grouped ? ' class="sel"' : ''}><td>${i + 1}</td><td>${esc(first(p.ChequeNumber, p.CheckNo, p.ChequeNo, p.TrxNo, ''))}</td><td>${esc(String(p.TrxDate || ''))}</td><td>${esc(String(p.TrxCode || ''))}</td><td>${esc(String(p.Description || ''))}</td><td>${esc(first(p.ArticleID, p.ArticleId, p.ArticleCode, ''))}</td><td class="num">${esc(String(first(p.HRSTaxRate, 0)))}</td><td class="num">${fmt(qty, 2)}</td><td class="num">${fmt(unit, 2)}</td><td class="num" style="font-weight:800;color:${amount >= 0 ? 'var(--green)' : '#ff99a7'}">${fmt(amount, 2)}</td></tr>`;
  }).join('');
}

function invoicePage(session, entry) {
  const s = summary(entry.data), list = postings(entry.data).sort((a, b) => num(a.TrxNo) - num(b.TrxNo)), cheques = chequeInfo(entry.data).list, grouped = groupedRows(list);
  return layout({
    title: `Invoice ${entry.billNo} - HRS Draft Invoice Hub`,
    nav: 'home',
    session,
    body: `<div class="hero"><h2>Draft Invoice ${esc(entry.billNo)}</h2><p>Live viewer for the cached invoice payload.</p></div>
    <div class="grid cards"><div class="card"><div class="lab">Hotel Code</div><div class="val">${esc(hotelCode(entry.data))}</div></div><div class="card"><div class="lab">Room Number</div><div class="val">${esc(roomNo(entry.data))}</div></div><div class="card"><div class="lab">Received</div><div class="val">${esc(entry.timestamp)}</div></div><div class="card"><div class="lab">Cheque Count</div><div class="val">${cheques.length}</div></div></div>
    <section class="panel"><div class="head"><div><div class="title">Folio Postings Ledger</div><div class="sub" id="count">${list.length} items</div></div><div class="tools">${cheques.length ? `<a class="btn" href="/invoice/${encodeURIComponent(entry.cacheKey)}/cheques">All cheque details</a>` : ''}<button class="btn" onclick="toggleGroup()">Group by package & tax rate</button><a class="btn" href="/">Back Home</a></div></div><div class="table-wrap"><table><thead><tr><th>Line</th><th>Cheque No.</th><th>Trx Date</th><th>Trx Code</th><th>Description</th><th>Article</th><th class="num">Tax Rate</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">HRS Amount</th></tr></thead><tbody id="pRows">${postingTable(list, false)}</tbody></table></div></section>
    <div class="grid cards" style="margin-top:16px"><div class="card"><div class="lab">Total Net</div><div class="val">${fmt(s.TotalNet)}</div></div><div class="card"><div class="lab">Total Gross</div><div class="val" style="color:var(--green)">${fmt(s.TotalGross)}</div></div><div class="card"><div class="lab">VAT 8 / 10 / 5</div><div class="val">${fmt(s.TotalVat8)} / ${fmt(s.TotalVat10)} / ${fmt(s.TotalVat5)}</div></div><div class="card"><div class="lab">Rounding</div><div class="val">${fmt(s.TotalRounding)}</div></div></div>
    <script>const raw=${safeJson(list)},grp=${safeJson(grouped || [])};let on=false;function make(rows,grouped){document.getElementById('pRows').innerHTML=rows.map((p,i)=>{const a=Number(p.HRSAmount||0),q=Number(p.Quantity||1)||1,u=q?a/q:a;return '<tr'+(grouped&&p.__grouped?' class="sel"':'')+'><td>'+(i+1)+'</td><td>'+String(p.ChequeNumber||p.CheckNo||p.ChequeNo||p.TrxNo||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</td><td>'+String(p.TrxDate||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</td><td>'+String(p.TrxCode||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</td><td>'+String(p.Description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</td><td>'+String(p.ArticleID||p.ArticleId||p.ArticleCode||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</td><td class="num">'+String(p.HRSTaxRate||0)+'</td><td class="num">'+Number(q).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td><td class="num">'+Number(u).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td><td class="num" style="font-weight:800;color:'+(a>=0?'var(--green)':'#ff99a7')+'">'+Number(a).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</td></tr>'}).join('');document.getElementById('count').textContent=rows.length+(grouped?' grouped item(s)':' item(s)')}function toggleGroup(){if(!grp.length)return toast('No TrxNoAgainstPackage found in this bill. Grouping is not available.',true);on=!on;make(on?grp:raw,on)}</script>`
  });
}

function chequesPage(session, entry) {
  const list = chequeInfo(entry.data).list;
  return layout({
    title: `Cheque Details ${entry.billNo} - HRS Draft Invoice Hub`,
    nav: 'home',
    session,
    body: `<div class="hero"><h2>All Cheque Details</h2><p>Bill ${esc(entry.billNo)} · ${list.length} cheque(s)</p></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${list.length ? list.map(c => `<section class="panel box"><div class="chip" style="margin-bottom:14px">Cheque ${esc(c.no)}</div><pre>${esc(decodeCheque(c.raw) || 'No cheque details available.')}</pre></section>`).join('') : `<section class="panel box"><div class="title">No cheque details found.</div></section>`}</div>`
  });
}

app.use((req, res, next) => {
  const session = getSession(req);
  if (session) req.adminSession = session;
  const page = req.method === 'GET' && (req.path === '/' || req.path === '/reports' || req.path === '/settings' || req.path.startsWith('/invoice/'));
  const api = req.path === '/api/dashboard/events' || req.path.startsWith('/api/invoices') || req.path.startsWith('/api/settings');
  if ((page || api) && !session) return page ? res.redirect('/login') : res.status(401).json({ StatusCode: 401, IsError: true, Message: 'Administrator session required.', Result: 'Please log in again.', ErrorCode: 401 });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'hrs-invoice-hub', invoices: invoices.size }));
app.get('/login', (req, res) => res.send(req.adminSession ? homePage(req.adminSession) : loginPage(req.query.error ? String(req.query.error) : '')));
app.post('/login', (req, res) => {
  const user = String(req.body?.username || '').trim(), pass = String(req.body?.password || '');
  if (user !== ADMIN.username || pass !== ADMIN.password) return res.redirect('/login?error=Invalid%20username%20or%20password');
  setCookie(res, req, newSession(), 7 * 24 * 60 * 60 * 1000);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  if (req.adminSession?.token) sessions.delete(req.adminSession.token);
  clearCookie(res, req);
  res.redirect('/login');
});

app.post('/connect/token', (req, res) => {
  if (!configReady() || !credsMatch(req.body || {})) return res.status(401).json(authPayload());
  res.json({ access_token: newApiToken(), token_type: 'Bearer', expires_in: 86400 });
});

app.post('/api/InvoiceHub/ImportInvoiceJsonData', express.json(), (req, res) => {
  try {
    if (!configReady() || !validApiToken(req)) return res.status(401).json(authPayload());
    let payload = req.body;
    if (typeof payload === 'string') payload = JSON.parse(payload);
    if (payload?.JsonData) payload = typeof payload.JsonData === 'string' ? JSON.parse(payload.JsonData) : payload.JsonData;
    const bill = String(billNo(payload) || `MOCK-${Date.now()}`);
    const s = summary(payload), vat = num(s.TotalVat8) + num(s.TotalVat10) + num(s.TotalVat5), rev = num(s.TotalNet);
    const exists = entries().some(e => e.billNo === bill);
    if (!settings.controls.allowDuplicateBill && exists) return res.json({ StatusCode: 201, IsError: true, Message: 'Bill Number existed', Result: 'Error! Please check message 102!', ErrorCode: 102 });
    if (!settings.controls.allowZeroRevVatBill && (rev <= 0 || vat <= 0)) return res.json({ StatusCode: 202, IsError: true, Message: 'Invoice has zero REV or VAT', Result: 'Error! Please check message 103!', ErrorCode: 103 });
    let cacheKey = bill, i = 2;
    while (settings.controls.allowDuplicateBill && invoices.has(cacheKey)) cacheKey = `${bill}__dup${i++}`;
    invoices.set(cacheKey, { billNo: bill, timestamp: new Date().toLocaleTimeString(), data: payload });
    notify({ type: 'invoice-received', billNo: cacheKey });
    res.json({ StatusCode: 200, IsError: false, Message: 'E-invoice is created.', Result: null, ErrorCode: 0 });
  } catch {
    res.status(500).json(serverPayload());
  }
});

app.get('/api/dashboard/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  dashboardClients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => { clearInterval(keepAlive); dashboardClients.delete(res); });
});

app.delete('/api/invoices', (req, res) => {
  const list = [...new Set(arr(req.body?.billNos).map(v => String(v)).filter(Boolean))];
  if (!list.length) return res.status(400).json({ StatusCode: 400, IsError: true, Message: 'Select at least one BillNo to delete.' });
  let removed = 0;
  list.forEach(v => { if (invoices.delete(v)) removed += 1; });
  notify({ type: 'invoice-deleted', removed });
  res.json({ StatusCode: 200, IsError: false, Message: `${removed} invoice${removed === 1 ? '' : 's'} removed from the live cache.`, Result: { deleted: removed } });
});

app.get('/api/settings', (req, res) => res.json({ StatusCode: 200, IsError: false, Message: 'Settings loaded.', Result: settings }));
app.post('/api/settings', (req, res) => {
  try { res.json({ StatusCode: 200, IsError: false, Message: 'Settings saved and applied immediately.', Result: saveSettings(req.body || {}) }); }
  catch (e) { res.status(500).json({ StatusCode: 500, IsError: true, Message: `Unable to save settings: ${e.message}` }); }
});

app.get('/', (req, res) => res.redirect(req.adminSession ? '/home' : '/login'));
app.get('/home', (req, res) => res.send(homePage(req.adminSession)));
app.get('/reports', (req, res) => res.send(reportsPage(req.adminSession)));
app.get('/settings', (req, res) => res.send(settingsPage(req.adminSession)));
app.get('/invoice/:bill', (req, res) => {
  const entry = findEntry(req.params.bill);
  if (!entry) return res.status(404).send('Bill not found');
  res.send(invoicePage(req.adminSession, entry));
});
app.get('/invoice/:bill/cheques', (req, res) => {
  const entry = findEntry(req.params.bill);
  if (!entry) return res.status(404).send('Bill not found');
  res.send(chequesPage(req.adminSession, entry));
});

app.listen(PORT, () => console.log(`Service running on port ${PORT}`));
