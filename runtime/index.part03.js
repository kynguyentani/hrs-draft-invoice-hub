    function escHtml(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
    function money(v){return Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
    function chequeKey(row){return String(row.ChequeNumber||row.CheckNo||row.ChequeNo||row.TrxNo||'')}
    function chequeAnchor(no){return 'cheque-'+String(no||'').trim().replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')}
    function linkCheque(no){const key=String(no||'');return chequeMap[key]?'<a class="row-link" href="'+chequeHref+'#'+chequeAnchor(key)+'">'+escHtml(key||'--')+'</a>':escHtml(key||'--')}
    function rowHtml(row,index,isGrouped){const amount=Number(row.HRSAmount||0),qty=Number(row.Quantity||1)||1,unit=row.__unit!=null?Number(row.__unit):qty?amount/qty:amount,chk=chequeKey(row),code=String(row.TrxCode||''),article=String(row.ArticleID||row.ArticleId||row.ArticleCode||''),desc=row.Description||trxMap[code]||'',articleDesc=artMap[code+'|'+article]||'';return '<tr'+(isGrouped?' class="sel"':'')+'><td>'+(index+1)+'</td><td>'+linkCheque(chk)+'</td><td>'+escHtml(String(row.TrxDate||''))+'</td><td>'+escHtml(code)+'</td><td>'+escHtml(desc)+'</td><td>'+escHtml(article)+'</td><td>'+escHtml(articleDesc)+'</td><td class="num">'+escHtml(String(row.HRSTaxRate||0))+'</td><td class="num">'+money(qty)+'</td><td class="num">'+money(unit)+'</td><td class="num" style="font-weight:800;color:'+(amount>=0?'var(--green)':'#ff9cab')+'">'+money(amount)+'</td></tr>'}
    function renderUngrouped(){document.getElementById('ledgerRows').innerHTML=rawRows.map((row,index)=>rowHtml(row,index,false)).join('')||'<tr><td colspan="11" class="empty">No postings with HRSAmount found.</td></tr>';document.getElementById('ledgerCount').textContent=rawRows.length+' items';document.getElementById('groupBadge').classList.remove('show')}
    function renderGrouped(){if(!rawRows.some(row=>{const ref=String(row.TrxNoAgainstPackage||'').trim();return ref&&ref!=='0'})){groupedOn=false;document.getElementById('groupBtn').classList.remove('primary');return toast('No TrxNoAgainstPackage found in this bill. Grouping is not available.',true)}const groups=new Map(),solo=[];rawRows.forEach(row=>{const ref=String(row.TrxNoAgainstPackage||'').trim();if(ref&&ref!=='0'){const key=ref+'||'+String(row.HRSTaxRate||'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}else solo.push(row)});const merged=[];groups.forEach(set=>{const lead=[...set].sort((a,b)=>Number(b.HRSAmount||0)-Number(a.HRSAmount||0))[0];merged.push({ChequeNumber:chequeKey(lead),TrxDate:lead.TrxDate,TrxCode:'',Description:pkgDesc,ArticleID:'',HRSTaxRate:lead.HRSTaxRate,Quantity:1,HRSAmount:set.reduce((sum,row)=>sum+Number(row.HRSAmount||0),0),__grouped:true,__unit:set.reduce((sum,row)=>{const qty=Number(row.Quantity||0);return sum+(qty?Number(row.HRSAmount||0)/qty:0)},0)})});const finalRows=[...merged,...solo];document.getElementById('ledgerRows').innerHTML=finalRows.map((row,index)=>rowHtml(row,index,!!row.__grouped)).join('');document.getElementById('ledgerCount').textContent=groups.size+' group'+(groups.size===1?'':'s')+(solo.length?' + '+solo.length+' item'+(solo.length===1?'':'s'):'');document.getElementById('groupBadge').classList.add('show')}
    function toggleGrouping(){groupedOn=!groupedOn;document.getElementById('groupBtn').classList.toggle('primary',groupedOn);if(groupedOn)renderGrouped();else renderUngrouped()}
    renderUngrouped();
    </script>`
  });
}

function chequesPageV2(session, entry) {
  const list = chequeInfo(entry.data).list;
  return layout({
    title: `Cheque Details ${entry.billNo} - HRS Draft Invoice Hub`,
    nav: 'home',
    session,
    body: `<div class="hero"><h2>All Cheque Details</h2><p>Bill ${esc(entry.billNo)} &middot; ${list.length} cheque(s)</p></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${list.length ? list.map(c => `<section class="panel box" id="cheque-${anchorId(c.no)}"><div class="chip" style="margin-bottom:14px">Cheque ${esc(c.no)}</div><pre>${esc(decodeCheque(c.raw) || 'No cheque details available.')}</pre></section>`).join('') : `<section class="panel box"><div class="title">No cheque details found.</div></section>`}</div>`
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
app.get('/login', (req, res) => res.send(req.adminSession ? homePageV2(req.adminSession) : loginPage(req.query.error ? String(req.query.error) : '')));
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
  res.json({ access_token: newApiToken(), token_type: 'Bearer', expires_in: 86400 });
});

app.post('/api/InvoiceHub/ImportInvoiceJsonData', express.json(), (req, res) => {
  try {
    if (!validApiToken(req)) return res.status(401).json(authPayload());
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
  const deleted = [], missing = [];
  list.forEach(v => {
    if (invoices.delete(v)) deleted.push(v);
    else missing.push(v);
  });
  notify({ type: 'invoice-deleted', removed: deleted.length });
  res.json({ StatusCode: 200, IsError: false, Message: `${deleted.length} invoice${deleted.length === 1 ? '' : 's'} removed from the live cache.`, Result: { deleted, missing } });
});

app.get('/api/settings', (req, res) => res.json({ StatusCode: 200, IsError: false, Message: 'Settings loaded.', Result: settings }));
app.post('/api/settings', (req, res) => {
  try { res.json({ StatusCode: 200, IsError: false, Message: 'Settings saved and applied immediately.', Result: saveSettings(req.body || {}) }); }
  catch (e) { res.status(500).json({ StatusCode: 500, IsError: true, Message: `Unable to save settings: ${e.message}` }); }
});

app.get('/', (req, res) => res.redirect(req.adminSession ? '/home' : '/login'));
app.get('/home', (req, res) => res.send(homePageV2(req.adminSession)));
app.get('/reports', (req, res) => res.send(reportsPage(req.adminSession)));
app.get('/settings', (req, res) => res.send(settingsPageV2(req.adminSession)));
app.get('/invoice/:bill', (req, res) => {
  const entry = findEntry(req.params.bill);
  if (!entry) return res.status(404).send('Bill not found');
  res.send(invoicePageV2(req.adminSession, entry));
});
app.get('/invoice/:bill/cheques', (req, res) => {
  const entry = findEntry(req.params.bill);
  if (!entry) return res.status(404).send('Bill not found');
  res.send(chequesPageV2(req.adminSession, entry));
});

app.listen(PORT, () => console.log(`Service running on port ${PORT}`));
