}
function descriptionMaps(d) {
  const trx = {};
  const art = {};
  let pkg = 'Package Revenue';
  arr(d?.TrxInfo || d?.FolioInfo?.TrxInfo).forEach(item => {
    const code = String(first(item?.Code, item?.TrxCode, '') || '');
    if (!code) return;
    trx[code] = String(item?.Description || trx[code] || '');
    if (String(item?.TrxType || '').toUpperCase() === 'PK' && item?.Description) pkg = String(item.Description);
    arr(item?.Articles?.Article).forEach(article => {
      [article?.ArticleID, article?.ArticleId, article?.ArticleCode]
        .filter(v => v !== undefined && v !== null && v !== '')
        .forEach(id => { art[`${code}|${String(id)}`] = String(article?.Description || ''); });
    });
  });
  return { trx, art, pkg };
}
function entries() {
  return Array.from(invoices.entries()).map(([cacheKey, rec]) => ({ cacheKey, billNo: rec.billNo || cacheKey, timestamp: rec.timestamp, data: rec.data }));
}
function findEntry(key) {
  const k = String(key);
  if (invoices.has(k)) { const rec = invoices.get(k); return { cacheKey: k, billNo: rec.billNo || k, timestamp: rec.timestamp, data: rec.data }; }
  return entries().find(e => e.billNo === k) || null;
}
function anchorId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'cheque';
}

function layout({ title, body, nav = 'home', session, login = false, topMeta = '' }) {
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
        <div class="top-right">
          ${topMeta ? `<div class="top-meta">${topMeta}</div>` : ''}
          <div class="user-box">
            <b>${esc(session?.displayName || '')}</b>
            <small>${esc(session?.username || '')}</small>
            <form method="post" action="/logout"><button class="signout-btn" type="submit">Sign Out</button></form>
          </div>
        </div>
      </header>
      <section class="wrap">${body}</section>
    </main>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#07111a;--panel:#0f1b29;--panel2:#122131;--line:#22384e;--txt:#edf4fb;--soft:#9bb0c6;--cyan:#34d8e7;--green:#4ade9b;--amber:#f4c04c;--danger:#ff6d80;--mono:Consolas,monospace;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07111a,#05101a);color:var(--txt);font-family:var(--font)}a{text-decoration:none;color:inherit}svg{display:block}button,input{font:inherit}
  .app{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{padding:24px 16px;background:#0a1520;border-right:1px solid rgba(255,255,255,.06)}.brand{display:flex;gap:12px;align-items:center;padding:8px}.logo{display:grid;place-items:center;width:54px;height:54px;border:1px solid rgba(52,216,231,.45);border-radius:16px;color:var(--cyan);font:800 25px var(--mono)}.brand strong,.top h1{display:block;margin:0;font-size:15px;text-transform:uppercase}.brand span,.top span{display:block;margin-top:4px;color:var(--cyan);font:700 11px var(--mono);letter-spacing:.12em;text-transform:uppercase}
  .nav{display:grid;gap:8px;margin-top:16px}.nav a{padding:14px 16px;border-radius:14px;color:var(--soft);border:1px solid transparent}.nav a.on,.nav a:hover{background:rgba(52,216,231,.08);border-color:rgba(52,216,231,.18);color:var(--txt)}
  .top{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:22px 26px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(7,17,26,.85)}.top-right{display:flex;align-items:center;gap:16px}.top-meta{display:grid;justify-items:end;gap:8px}.live-chip{display:inline-flex;align-items:center;gap:8px;min-height:32px;padding:0 12px;border-radius:999px;border:1px solid rgba(52,216,231,.18);background:rgba(52,216,231,.08);color:#a6fbff;font:800 11px var(--mono);text-transform:uppercase}.live-chip.off{border-color:rgba(244,192,76,.2);background:rgba(244,192,76,.1);color:var(--amber)}.live-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px rgba(255,255,255,.06)}.meta-note{color:var(--soft);font-size:12px}.meta-note strong{color:var(--txt)}.user-box{display:grid;justify-items:end}.user-box b{margin-top:0}.user-box small{color:var(--soft)}.user-box form{margin-top:8px}.signout-btn{height:32px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--txt);cursor:pointer}.signout-btn:hover{background:rgba(255,255,255,.08)}
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
  @media (max-width:980px){.app{grid-template-columns:1fr}.side{display:none}.top{padding:18px;flex-wrap:wrap}.top-right{width:100%;justify-content:space-between}.top-meta{justify-items:start}.user-box{justify-items:start}.wrap{padding:18px}.hero h2{font-size:28px}}
  </style></head><body>${login ? body : shell}<div id="toast" class="toast"></div><script>function toast(m,e){const t=document.getElementById('toast');if(!t)return;t.textContent=m;t.className='toast show'+(e?' err':'');clearTimeout(window.__t);window.__t=setTimeout(()=>t.className='toast',2600)}</script></body></html>`;
}

function loginPage(error = '') {
  const setupHint = ADMIN.password ? '' : `<div class="sub" style="margin-top:14px">Administrator password is configured through <code>HRS_ADMIN_PASSWORD</code>.</div>`;
  return layout({
    title: 'Login - HRS Draft Invoice Hub',
    login: true,
    body: `<div class="login"><form class="login-card" method="post" action="/login"><div class="logo">HRS</div><h2>HRS Draft Invoice Hub</h2><div class="login-sub">Administrator Access</div>${error ? `<div class="err">${esc(error)}</div>` : ''}<div class="field"><label>Username</label><input class="in" name="username" value="${esc(ADMIN.username)}" autocomplete="username"></div><div class="field"><label>Password</label><input class="in" type="password" name="password" value="" autocomplete="current-password"></div><button class="btn primary" style="width:100%;height:60px;font-size:22px;margin-top:8px">Sign In</button>${setupHint}</form></div>`
  });
}

function reportsPage(session) {
  return layout({ title: 'Reports - HRS Draft Invoice Hub', nav: 'reports', session, body: `<div class="hero"><h2>Reports</h2><p>Reserved for future reporting modules.</p></div><section class="panel"><div class="head"><div><div class="title">Coming Later</div><div class="sub">This section will be developed when report definitions are ready.</div></div></div></section>` });
}

function homeRowsHtmlV2(list) {
  if (!list.length) return `<tr class="home-empty-row"><td colspan="19" class="empty"><strong>Waiting for draft invoices</strong><span>New connector transactions will appear here automatically.</span></td></tr>`;
  return list.map(entry => {
    const s = summary(entry.data);
    const chequeCount = chequeInfo(entry.data).list.length;
    return `<tr class="home-row" data-bill="${esc(entry.cacheKey)}"><td><input type="checkbox" class="selbox" value="${esc(entry.cacheKey)}"></td><td><div class="time"><span class="dot"></span><span>${esc(entry.timestamp)}</span></div></td><td style="color:var(--cyan);font-weight:800">${esc(hotelCode(entry.data))}</td><td>${esc(roomNo(entry.data))}</td><td><a class="bill" href="/invoice/${encodeURIComponent(entry.cacheKey)}">${esc(entry.billNo)}</a>${chequeCount ? ` <a class="chip" href="/invoice/${encodeURIComponent(entry.cacheKey)}/cheques" title="All cheque details">${chequeCount}</a>` : ''}</td><td class="num">${fmt(s.TotalNet)}</td><td class="num">${fmt(s.TotalSvc8)}</td><td class="num">${fmt(s.TotalSvc10)}</td><td class="num">${fmt(s.TotalVat8)}</td><td class="num">${fmt(s.TotalVat10)}</td><td class="num">${fmt(s.TotalVat5)}</td><td class="num">${fmt(s.TotalSct30)}</td><td class="num">${fmt(s.TotalSct20)}</td><td class="num" style="color:var(--green);font-weight:800">${fmt(s.TotalGross)}</td><td class="num">${fmt(s.TotalTip)}</td><td class="num">${fmt(s.TotalPaidOut)}</td><td class="num">${fmt(s.TotalRounding)}</td><td class="num" style="color:var(--amber);font-weight:800">${fmt(paymentTotal(entry.data))}</td><td><button class="del" type="button" onclick="requestDelete(['${encodeURIComponent(entry.cacheKey)}'], this)">X</button></td></tr>`;
  }).join('');
}

function homePageV2(session) {
  const list = entries().sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
  const last = list[0]?.timestamp || 'Waiting for data';
  const live = list.length ? 'Live' : 'Standby';
  return layout({
    title: 'Home - HRS Draft Invoice Hub',
    nav: 'home',
    session,
    topMeta: `<span class="live-chip${list.length ? '' : ' off'}"><span class="live-dot"></span>${esc(live)}</span><span class="meta-note">Last received: <strong>${esc(last)}</strong></span>`,
    body: `<style>
    .home-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.home-note{color:var(--soft);font:700 11px var(--mono);text-transform:uppercase}.home-panel table{min-width:1680px}.home-row{transition:opacity .18s ease,transform .18s ease}.home-row.deleting{opacity:0;transform:translateX(10px)}.home-empty-row td{padding:56px 20px}.modal-backdrop{position:fixed;inset:0;display:grid;place-items:center;padding:20px;background:rgba(4,10,15,.7);backdrop-filter:blur(8px);opacity:0;visibility:hidden;transition:.18s;z-index:30}.modal-backdrop.show{opacity:1;visibility:visible}.confirm-box{width:min(420px,100%);padding:22px;border-radius:20px;border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,var(--panel2),var(--panel));box-shadow:0 20px 60px rgba(0,0,0,.32)}.confirm-box h3{margin:0 0 10px;font-size:22px}.confirm-box p{margin:0;color:var(--soft);line-height:1.6}.confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}@media (max-width:980px){.home-panel table{min-width:1540px}}
    </style>
    <div class="hero"><h2>Live Draft Invoice Transactions</h2><p>Real-time feed of invoices received via API endpoint.</p></div>
    <div class="grid cards"><div class="card"><div class="lab">Total Invoices</div><div class="val" id="metricCount">${list.length}</div></div><div class="card"><div class="lab">Last Update</div><div class="val">${esc(last)}</div></div><div class="card"><div class="lab">Selected</div><div class="val" id="selectedCount">0</div></div></div>
    <section class="panel home-panel"><div class="head"><div><div class="title">Live Transactions</div><div class="sub">Extended monitor view with the legacy finance columns.</div></div><div class="home-toolbar"><span class="badge" id="recordBadge">${list.length} record${list.length === 1 ? '' : 's'}</span><span class="home-note" id="toolbarSelected">0 selected</span><span class="home-note">Updated <strong>${esc(last)}</strong></span><button id="bulkDeleteBtn" class="btn danger" hidden onclick="requestDelete(selectedBills(), document.getElementById('bulkDeleteBtn'))">Delete Selected</button></div></div><div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="all"></th><th>Time Received</th><th>Hotel</th><th>Room</th><th>Bill Number</th><th class="num">Total Net</th><th class="num">Svc 8%</th><th class="num">Svc 10%</th><th class="num">VAT 8%</th><th class="num">VAT 10%</th><th class="num">VAT 5%</th><th class="num">Sct 30%</th><th class="num">Sct 20%</th><th class="num">Total Gross</th><th class="num">Tip</th><th class="num">Paid Out</th><th class="num">Rounding</th><th class="num">Total Payment</th><th>Action</th></tr></thead><tbody id="rows">${homeRowsHtmlV2(list)}</tbody></table></div></section>
    <div id="deleteModal" class="modal-backdrop" onclick="if(event.target===this)closeDelete()"><div class="confirm-box"><h3 id="deleteTitle">Delete invoice?</h3><p id="deleteText">The selected invoice will be removed from the live cache.</p><div class="confirm-actions"><button class="btn" type="button" onclick="closeDelete()">Cancel</button><button class="btn danger" id="confirmDeleteBtn" type="button" onclick="confirmDelete()">Delete</button></div></div></div>
    <script>
    let pendingBills=[],pendingFocus=null;const all=document.getElementById('all'),bulk=document.getElementById('bulkDeleteBtn'),sc=document.getElementById('selectedCount'),countEl=document.getElementById('metricCount');
    function boxes(){return Array.from(document.querySelectorAll('.selbox'))}
    function selectedBills(){return boxes().filter(x=>x.checked).map(x=>decodeURIComponent(x.value))}
    function sync(){const b=boxes(),sel=selectedBills(),rows=document.querySelectorAll('tbody tr[data-bill]');sc.textContent=String(sel.length);countEl.textContent=String(rows.length);document.getElementById('toolbarSelected').textContent=sel.length+' selected';bulk.hidden=!sel.length;all.checked=b.length&&sel.length===b.length;all.indeterminate=sel.length>0&&sel.length<b.length;rows.forEach(r=>{const c=r.querySelector('.selbox');r.classList.toggle('sel',!!c&&c.checked)});document.getElementById('recordBadge').textContent=rows.length+' record'+(rows.length===1?'':'s')}
    function requestDelete(bills,source){if(!bills.length)return;pendingBills=bills;pendingFocus=source||null;document.getElementById('deleteTitle').textContent=bills.length>1?'Delete selected invoices?':'Delete invoice?';document.getElementById('deleteText').textContent=bills.length>1?bills.length+' invoices will be removed from the live cache.':'The selected invoice will be removed from the live cache.';document.getElementById('confirmDeleteBtn').textContent=bills.length>1?'Delete invoices':'Delete invoice';document.getElementById('deleteModal').classList.add('show')}
    function closeDelete(){document.getElementById('deleteModal').classList.remove('show');if(pendingFocus)pendingFocus.focus();pendingFocus=null;pendingBills=[]}
    async function confirmDelete(){const bills=[...pendingBills];if(!bills.length)return;const btn=document.getElementById('confirmDeleteBtn');btn.disabled=true;btn.textContent='Deleting...';try{const r=await fetch('/api/invoices',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({billNos:bills})});const j=await r.json();if(!r.ok||j.IsError)throw new Error(j.Message||'Delete failed');bills.forEach(bill=>{const row=document.querySelector('tr[data-bill="'+CSS.escape(bill)+'"]');if(row)row.classList.add('deleting')});setTimeout(()=>{bills.forEach(bill=>{const row=document.querySelector('tr[data-bill="'+CSS.escape(bill)+'"]');if(row)row.remove()});if(!document.querySelector('tbody tr[data-bill]'))document.getElementById('rows').innerHTML=${safeJson(homeRowsHtmlV2([]))};sync()},180);toast(bills.length>1?'Selected invoices deleted.':'Invoice deleted.');closeDelete()}catch(err){toast(err.message||'Delete failed',true)}finally{btn.disabled=false;if(document.getElementById('deleteModal').classList.contains('show'))btn.textContent=pendingBills.length>1?'Delete invoices':'Delete invoice'}}
    all&&all.addEventListener('change',e=>{boxes().forEach(x=>x.checked=e.target.checked);sync()});document.addEventListener('change',e=>{if(e.target.matches('.selbox'))sync()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDelete()});sync();const es=new EventSource('/api/dashboard/events');es.onmessage=(event)=>{try{const data=JSON.parse(event.data);if(data.type==='invoice-received')window.location.reload()}catch{window.location.reload()}};
    </script>`
  });
}

function settingsPageV2(session) {
  return layout({
    title: 'Settings - HRS Draft Invoice Hub',
    nav: 'settings',
    session,
    body: `<div class="hero"><h2>System Settings</h2><p>Controls save automatically and persist after reloads and service restarts.</p></div>
    <div class="settings"><section class="panel box"><h3>Controls</h3><p>These business rules are saved immediately when a toggle changes.</p><div class="toggle"><div><strong>Allow duplicate bill</strong><div class="sub">Off by default.</div></div><label class="switch"><input id="allowDuplicateBill" type="checkbox" ${settings.controls.allowDuplicateBill ? 'checked' : ''}><span class="slider"></span></label></div><div class="toggle" style="margin-top:12px"><div><strong>Allow zero Rev/VAT bill</strong><div class="sub">On by default.</div></div><label class="switch"><input id="allowZeroRevVatBill" type="checkbox" ${settings.controls.allowZeroRevVatBill ? 'checked' : ''}><span class="slider"></span></label></div><div class="sub" id="settingsState" style="margin-top:16px">Waiting for changes.</div></section></div>
    <script>
    let saving=false;async function saveCfg(){if(saving)return;saving=true;settingsState.textContent='Saving...';const payload={controls:{allowDuplicateBill:allowDuplicateBill.checked,allowZeroRevVatBill:allowZeroRevVatBill.checked}};const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();saving=false;if(!r.ok||j.IsError){settingsState.textContent=j.Message||'Unable to save settings.';return toast(j.Message||'Unable to save settings.',true)}settingsState.textContent='Saved and applied immediately.';toast('Settings saved and applied immediately.')}allowDuplicateBill.addEventListener('change',saveCfg);allowZeroRevVatBill.addEventListener('change',saveCfg);
    </script>`
  });
}

function invoicePageV2(session, entry) {
  const data = entry.data;
  const s = summary(data);
  const rows = validPostings(data);
  const cheques = chequeInfo(data).list;
  const chequeMap = chequeInfo(data).map;
  const maps = descriptionMaps(data);
  const ri = reservationInfo(data);
  const derivedBillDate = first(data?.FolioInfo?.FolioHeaderInfo?.BillGenerationDate, data?.DocumentInfo?.BillGenerationDate, data?.FolioDeliveryInfo?.BillGenerationDate, data?.DocumentInfo?.BusinessDateTime);
  const totalsHtml = [
    ['Total Net', s.TotalNet], ['Total SVC8', s.TotalSvc8], ['Total SVC10', s.TotalSvc10], ['Total VAT8', s.TotalVat8], ['Total VAT10', s.TotalVat10], ['Total VAT5', s.TotalVat5], ['Total SCT30', s.TotalSct30], ['Total SCT20', s.TotalSct20], ['Total Gross', s.TotalGross], ['Total TIP', s.TotalTip], ['Total PaidOut', s.TotalPaidOut], ['Total Rounding', s.TotalRounding]
  ].map(([label, value]) => `<tr${label === 'Total Gross' ? ' class="total-major"' : ''}><td>${label}</td><td class="num">${fmt(value, 2)}</td></tr>`).join('');
  const chequeStrip = cheques.length ? `<div class="cheque-strip-wrap"><a class="btn" href="/invoice/${encodeURIComponent(entry.cacheKey)}/cheques">View ${cheques.length} cheque(s)</a><div class="cheque-strip">${cheques.map(c => `<a class="cheque-pill" href="/invoice/${encodeURIComponent(entry.cacheKey)}/cheques#cheque-${anchorId(c.no)}">${esc(c.no)}</a>`).join('')}</div></div>` : '';
  return layout({
    title: `Invoice ${entry.billNo} - HRS Draft Invoice Hub`,
    nav: 'home',
    session,
    body: `<style>
    .invoice-wrap{display:grid;gap:18px}.draft-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.draft-chip{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--txt);font:800 11px var(--mono);text-transform:uppercase}.draft-chip.cheques{border-color:rgba(74,222,155,.24);background:rgba(74,222,155,.12);color:var(--green)}.header-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}.mini-card{padding:18px;border-radius:18px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03)}.mini-label{color:var(--soft);font:700 10px var(--mono);text-transform:uppercase}.mini-value{margin-top:8px;font-weight:800;word-break:break-word}.invoice-tools{display:flex;gap:10px;flex-wrap:wrap}.invoice-ledger table{min-width:1160px}.grouped-badge{display:none}.grouped-badge.show{display:inline-flex}.cheque-strip-wrap{display:grid;gap:10px}.cheque-strip{display:flex;flex-wrap:wrap;gap:6px}.cheque-pill{display:inline-flex;align-items:center;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(74,222,155,.24);background:rgba(74,222,155,.12);color:var(--green);font:800 11px var(--mono)}.cheque-pill:hover{background:rgba(74,222,155,.18)}.row-link{color:#a6fbff;text-decoration:underline;text-decoration-color:rgba(166,251,255,.35)}.invoice-ledger .sel{background:rgba(52,216,231,.08)}.totals-table td{padding:12px 16px}.totals-table .total-major td{color:var(--green);font-weight:800;border-top:1px solid rgba(255,255,255,.08)}
    </style>
    <div class="hero"><h2>Draft Invoice Viewer</h2><p>Live viewer for the cached invoice payload with the restored ledger details.</p></div>
    <div class="invoice-wrap"><div class="draft-bar"><span class="draft-chip">Draft Invoice</span>${cheques.length ? `<a class="draft-chip cheques" href="/invoice/${encodeURIComponent(entry.cacheKey)}/cheques">All Cheque Details</a>` : ''}</div>${chequeStrip}<div class="panel" style="padding:22px"><div class="header-grid"><div class="mini-card"><div class="mini-label">Hotel Code</div><div class="mini-value">${esc(hotelCode(data))}</div></div><div class="mini-card"><div class="mini-label">Room Number</div><div class="mini-value">${esc(roomNo(data))}</div></div><div class="mini-card"><div class="mini-label">Bill Number</div><div class="mini-value">${esc(entry.billNo)}</div></div><div class="mini-card"><div class="mini-label">Bill Gen Date</div><div class="mini-value">${esc(formatDate(derivedBillDate))}</div></div><div class="mini-card"><div class="mini-label">Confirmation No</div><div class="mini-value">${esc(first(ri.ConfirmationNo, '--'))}</div></div><div class="mini-card"><div class="mini-label">Arrival Date</div><div class="mini-value">${esc(formatDate(ri.ArrivalDate))}</div></div><div class="mini-card"><div class="mini-label">Departure Date</div><div class="mini-value">${esc(formatDate(ri.DepartureDate))}</div></div><div class="mini-card"><div class="mini-label">RESV_NAME_ID</div><div class="mini-value">${esc(first(ri.ResvNameID, '--'))}</div></div></div></div>
    <section class="panel invoice-ledger"><div class="head"><div><div class="title">Posting Details</div><div class="sub" id="ledgerCount">${rows.length} items</div></div><div class="invoice-tools"><span class="badge grouped-badge" id="groupBadge">Grouped</span><button class="btn" id="groupBtn" type="button" onclick="toggleGrouping()">Group by package & tax rate</button><button class="btn" type="button" onclick="window.print()">Print</button></div></div><div class="table-wrap"><table><thead><tr><th>Line</th><th>Cheque No.</th><th>Trx Date</th><th>Trx Code</th><th>Trx Code Desc</th><th>Article ID</th><th>Article Desc</th><th class="num">Tax Rate</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead><tbody id="ledgerRows"></tbody></table></div></section>
    <section class="panel"><div class="head"><div><div class="title">Invoice Totals</div><div class="sub">Restored detailed totals view</div></div></div><div class="table-wrap"><table class="totals-table"><tbody>${totalsHtml}</tbody></table></div></section></div>
    <script>
    const rawRows=${safeJson(rows)},trxMap=${safeJson(maps.trx)},artMap=${safeJson(maps.art)},pkgDesc=${safeJson(maps.pkg)},chequeMap=${safeJson(chequeMap)},chequeHref=${safeJson(`/invoice/${encodeURIComponent(entry.cacheKey)}/cheques`)};
    let groupedOn=false;
