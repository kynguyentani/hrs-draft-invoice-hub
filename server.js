const express = require('express');
const app = express();

// Use the hosting platform's assigned port, while preserving 9090 locally.
const PORT = Number(process.env.PORT) || 9090;

// Increase payload limits to support large base64 strings and dense folio data
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// In-memory data store for live transactions received from the connector
const invoiceStore = new Map();
const dashboardClients = new Set();

function notifyDashboardClients(event) {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of dashboardClients) {
        client.write(message);
    }
}

// --- Static Descriptions Dictionary Matchers ---
const INV_TRX_DESC = {
  "9000": "ROOM CHARGE", "9001": "SERVICE CHARGE 8%", "9002": "SERVICE CHARGE 10%",
  "9003": "VAT 8%", "9004": "VAT 10%", "9005": "VAT 5%", "9006": "SCT 30%", "9007": "SCT 20%",
  "9999": "ROUNDING ADJUSTMENT", "1000": "CASH PAYMENT", "1001": "CREDIT CARD", "1002": "CITY LEDGER"
};

const INV_ART_DESC = {
  "9000|RM": "Deluxe Room Night", "9001|SVC8": "Service Charge Allocation 8%",
  "9002|SVC10": "Service Charge Allocation 10%", "9003|VAT8": "Value Added Tax 8%",
  "9004|VAT10": "Value Added Tax 10%", "9005|VAT5": "Value Added Tax 5%",
  "9006|SCT30": "Special Consumption Tax 30%", "9007|SCT20": "Special Consumption Tax 20%"
};

const DASH = '&mdash;';

function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function escapeHtml(value) {
    return String(value == null || value === '' ? DASH : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeScriptJson(value) {
    return JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
}

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function numberValue(...values) {
    const value = firstValue(...values);
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatNum(value, fractionDigits = 0) {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return fractionDigits ? '0.00' : '0';
    return parsed.toLocaleString('en-US', {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits
    });
}

function formatDate(value) {
    if (!value) return DASH;
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

function getBillNo(data) {
    return firstValue(
        data?.FolioDeliveryInfo?.BillNo,
        data?.DocumentInfo?.BillNo,
        data?.FolioInfo?.FolioHeaderInfo?.BillNo
    );
}

function createInvoiceStoreKey(billNo) {
    const baseKey = String(billNo);
    if (!invoiceStore.has(baseKey)) return baseKey;

    let copy = 2;
    let nextKey = `${baseKey}__dup${copy}`;
    while (invoiceStore.has(nextKey)) {
        copy += 1;
        nextKey = `${baseKey}__dup${copy}`;
    }
    return nextKey;
}

function getDisplayBillNo(key, record) {
    return firstValue(record?.billNo, getBillNo(record?.data), key);
}

function getHotelCode(data) {
    return firstValue(
        data?.HotelInfo?.HotelCode,
        data?.FolioDeliveryInfo?.HotelCode,
        data?.DocumentInfo?.HotelCode
    );
}

function getReservationInfo(data) {
    return data?.ReservationInfo || data?.FolioInfo?.ReservationInfo || {};
}

function getRoomNo(data) {
    const ri = getReservationInfo(data);
    return firstValue(data?.FolioDeliveryInfo?.RoomNo, data?.FolioDeliveryInfo?.RoomNumber, ri.RoomNumber);
}

function getSummaryInfo(data) {
    return data?.FolioSummaryInfo || data?.TotalInfo || data?.FolioInfo?.TotalInfo || {};
}

function getPostings(data) {
    return toArray(data?.FolioPostingDetails || data?.Postings?.Posting || data?.FolioInfo?.Postings);
}

function getValidPostings(data) {
    return getPostings(data)
        .filter(p => p && p.HRSAmount != null && p.HRSAmount !== 0 && p.HRSAmount !== '0')
        .sort((a, b) => (parseFloat(a.TrxNo) || 0) - (parseFloat(b.TrxNo) || 0));
}

function buildDescriptionMaps(data) {
    const trxDescMap = { ...INV_TRX_DESC };
    const articleDescMap = { ...INV_ART_DESC };
    let packageDescription = trxDescMap["9999"] || "Package Wrapper";

    for (const trx of toArray(data?.TrxInfo || data?.FolioInfo?.TrxInfo)) {
        const code = trx.Code || trx.TrxCode || '';
        if (code) trxDescMap[code] = trx.Description || trxDescMap[code] || '';
        if ((trx.TrxType || '').toUpperCase() === 'PK' && trx.Description) {
            packageDescription = trx.Description;
        }
        for (const article of toArray(trx.Articles?.Article)) {
            const ids = [article.ArticleID, article.ArticleId, article.ArticleCode].filter(v => v !== undefined && v !== null && v !== '');
            for (const id of ids) {
                articleDescMap[`${code}|${String(id)}`] = article.Description || '';
            }
        }
    }

    return { trxDescMap, articleDescMap, packageDescription };
}

function getChequeDetails(data) {
    const chequeMap = {};
    const allChequeDetails = [];
    const seen = new Set();

    const addCheque = (no, details, aliases = []) => {
        if (!no || !details) return;
        const chequeNo = String(no);
        const detail = Array.isArray(details) ? details[0] : details;
        if (!detail) return;
        if (!seen.has(chequeNo)) {
            seen.add(chequeNo);
            allChequeDetails.push({ no: chequeNo, b64: String(detail) });
        }
        for (const key of [chequeNo, ...aliases].filter(Boolean)) {
            chequeMap[String(key)] = String(detail);
        }
    };

    for (const ci of toArray(data?.FolioInfo?.PosChequeInfo || data?.PosChequeInfo)) {
        if (!ci) continue;
        addCheque(ci.ChequeNo || ci.CheckNo || ci.TrxNo, ci.ChequeDetails, [ci.TrxNo, ci.ChequeNo, ci.CheckNo]);
    }

    for (const p of getPostings(data)) {
        if (!p?.ChequeDetails || String(p.ChequeDetails).trim() === '') continue;
        try {
            const parsed = JSON.parse(p.ChequeDetails);
            addCheque(parsed.CheckNo || parsed.ChequeNo || p.ChequeNumber || p.TrxNo, p.ChequeDetails, [p.ChequeNumber, p.TrxNo]);
        } catch (e) {
            addCheque(p.ChequeNumber || p.TrxNo, p.ChequeDetails, [p.ChequeNumber, p.TrxNo]);
        }
    }

    return { chequeMap, allChequeDetails };
}

// ==========================================
// 1. OAUTH TOKEN ENDPOINT (Step 1)
// ==========================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'hrs-invoice-hub',
        invoices: invoiceStore.size
    });
});

app.post('/connect/token', (req, res) => {
    const { username, client_id } = req.body;
    console.log(`[\x1b[35mAUTH\x1b[0m] Token issued matching client: ${client_id || 'N/A'} (User: ${username || 'N/A'})`);
    
    res.json({
        access_token: `mock_hrs_secure_bearer_token_${Math.random().toString(36).substr(2, 9)}`,
        token_type: "Bearer",
        expires_in: 86400
    });
});

// ==========================================
// 2. INVOICE IMPORT JSON ENDPOINT (Step 2)
// ==========================================
app.post('/api/InvoiceHub/ImportInvoiceJsonData', (express.json()), (req, res) => {
    console.log(`[\x1b[36mRECEIVER\x1b[0m] Inbound transaction payload detected.`);
    
    try {
        let payload = req.body;
        if (typeof payload === 'string') {
            payload = JSON.parse(payload);
        }

        // Handle inner raw string payload container wrapper if it exists
        if (payload && payload.JsonData) {
            let innerData = payload.JsonData;
            if (typeof innerData === 'string') {
                innerData = JSON.parse(innerData);
            }
            payload = innerData;
        }

        const billNo = payload?.FolioDeliveryInfo?.BillNo
            || payload?.DocumentInfo?.BillNo
            || payload?.FolioInfo?.FolioHeaderInfo?.BillNo
            || `MOCK-${Date.now()}`;
        
        // Cache each inbound payload as its own transaction, even when BillNo repeats.
        const displayBillNo = billNo.toString();
        const billKey = createInvoiceStoreKey(displayBillNo);
        invoiceStore.set(billKey, {
            billNo: displayBillNo,
            timestamp: new Date().toLocaleTimeString(),
            data: payload
        });

        console.log(`[\x1b[32mSUCCESS\x1b[0m] Cached BillNo: \x1b[33m${displayBillNo}\x1b[0m globally as \x1b[36m${billKey}\x1b[0m [Folio Records: ${getPostings(payload).length}]`);
        notifyDashboardClients({ type: 'invoice-received', billNo: billKey, displayBillNo, isNew: true });

        res.json({
            StatusCode: 200,
            IsError: false,
            Message: `E-invoice is created.`,
            Result: displayBillNo || "EINVOICE",
            ErrorCode: 0
        });

    } catch (err) {
        console.error(`[\x1b[31mERROR\x1b[0m] Parsing error structural failure:`, err.message);
        res.status(400).json({
            StatusCode: 400,
            IsError: true,
            Message: `Malformed schema structure processing exception: ${err.message}`,
            Result: null,
            ErrorCode: 99
        });
    }
});

app.get('/api/dashboard/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    dashboardClients.add(res);

    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
        clearInterval(keepAlive);
        dashboardClients.delete(res);
    });
});

app.delete('/api/invoices', (req, res) => {
    const billNos = [...new Set(toArray(req.body?.billNos).map(value => String(value)).filter(Boolean))];
    if (billNos.length === 0) {
        return res.status(400).json({
            StatusCode: 400,
            IsError: true,
            Message: 'Select at least one BillNo to delete.'
        });
    }

    const deleted = [];
    const missing = [];
    for (const billNo of billNos) {
        if (invoiceStore.delete(billNo)) {
            deleted.push(billNo);
            console.log(`[\x1b[33mDELETE\x1b[0m] Removed cached BillNo: \x1b[31m${billNo}\x1b[0m`);
        } else {
            missing.push(billNo);
        }
    }

    res.json({
        StatusCode: 200,
        IsError: false,
        Message: `${deleted.length} invoice${deleted.length === 1 ? '' : 's'} removed from the live cache.`,
        Result: { deleted, missing }
    });
});

app.delete('/api/invoices/:billNo', (req, res) => {
    const billNo = req.params.billNo.toString();
    if (!invoiceStore.has(billNo)) {
        return res.status(404).json({
            StatusCode: 404,
            IsError: true,
            Message: `BillNo ${billNo} was not found in the live cache.`
        });
    }

    invoiceStore.delete(billNo);
    console.log(`[\x1b[33mDELETE\x1b[0m] Removed cached BillNo: \x1b[31m${billNo}\x1b[0m`);
    res.json({
        StatusCode: 200,
        IsError: false,
        Message: `BillNo ${billNo} was removed from the live cache.`,
        Result: billNo
    });
});

// ==========================================
// 3. MONITOR DASHBOARD & DRAFT INVOICE VIEWER
// ==========================================
app.get('/', (req, res) => {
    let rowsHtml = '';
    const invoiceValues = Array.from(invoiceStore.values());
    const lastReceived = invoiceValues.length ? invoiceValues[invoiceValues.length - 1].timestamp : 'Waiting for data';
    const monitorState = invoiceStore.size ? 'Live' : 'Standby';

    if (invoiceStore.size === 0) {
        rowsHtml = `
            <tr class="empty-row">
                <td colspan="19">
                    <div class="empty-state">
                        <span class="empty-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 16 0"/><path d="M7 12a5 5 0 0 1 10 0"/><path d="M10 12a2 2 0 0 1 4 0"/><path d="M12 15v5"/></svg>
                        </span>
                        <strong>Waiting for draft invoices</strong>
                        <span>New connector transactions will appear here automatically.</span>
                    </div>
                </td>
            </tr>`;
    } else {
        invoiceStore.forEach((value, key) => {
            const d = value.data;
            const sum = getSummaryInfo(d);
            const chequeCount = getChequeDetails(d).allChequeDetails.length;
            const displayBillNo = getDisplayBillNo(key, value);
            let totalPayment = 0;

            for (const b of toArray(d.RevenueBucketInfo || d.FolioInfo?.RevenueBucketInfo)) {
                if (b.BucketType === "FLIP_PAY_TYPE") {
                    totalPayment += parseFloat(b.BucketCodeTotalGross || 0);
                }
            }

            rowsHtml += `
                <tr class="invoice-row" data-bill="${escapeHtml(key)}" data-bill-label="${escapeHtml(displayBillNo)}">
                    <td class="select-cell">
                        <input type="checkbox" class="row-select" value="${escapeHtml(key)}" aria-label="Select bill ${escapeHtml(displayBillNo)}" onchange="syncSelectionState()">
                    </td>
                    <td class="time-cell">
                        <span class="row-signal" aria-hidden="true"></span>
                        <time>${escapeHtml(value.timestamp)}</time>
                    </td>
                    <td class="hotel-cell">${escapeHtml(getHotelCode(d))}</td>
                    <td class="room-cell">${escapeHtml(getRoomNo(d))}</td>
                    <td class="bill-cell">
                        <div class="bill-actions">
                            <a class="bill-link" href="/invoice/${encodeURIComponent(key)}" target="_blank" rel="noopener" aria-label="Open draft invoice ${escapeHtml(displayBillNo)}">
                                <span>${escapeHtml(displayBillNo)}</span>
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                            </a>
                            ${chequeCount > 0 ? `
                                <button type="button" class="cheque-count" onclick="openChequeDetails(event,'${encodeURIComponent(key)}')" aria-label="View ${chequeCount} associated POS cheques for bill ${escapeHtml(displayBillNo)}" title="View ${chequeCount} associated POS cheque${chequeCount === 1 ? '' : 's'}">
                                    ${chequeCount}
                                </button>` : ''}
                        </div>
                    </td>
                    <td class="number-cell primary-value">${formatNum(sum.TotalNet)}</td>
                    <td class="number-cell secondary-value">${formatNum(firstValue(sum.TotalSvc8, sum.TotalSVC8))}</td>
                    <td class="number-cell secondary-value">${formatNum(firstValue(sum.TotalSvc10, sum.TotalSVC10))}</td>
                    <td class="number-cell secondary-value">${formatNum(firstValue(sum.TotalVat8, sum.TotalVAT8))}</td>
                    <td class="number-cell secondary-value">${formatNum(firstValue(sum.TotalVat10, sum.TotalVAT10))}</td>
                    <td class="number-cell secondary-value">${formatNum(firstValue(sum.TotalVat5, sum.TotalVAT5))}</td>
                    <td class="number-cell">${formatNum(firstValue(sum.TotalSct30, sum.TotalSCT30))}</td>
                    <td class="number-cell">${formatNum(firstValue(sum.TotalSct20, sum.TotalSCT20))}</td>
                    <td class="number-cell gross-value">${formatNum(sum.TotalGross)}</td>
                    <td class="number-cell">${formatNum(firstValue(sum.TotalTip, sum.TotalTIP))}</td>
                    <td class="number-cell">${formatNum(sum.TotalPaidOut)}</td>
                    <td class="number-cell secondary-value">${formatNum(sum.TotalRounding)}</td>
                    <td class="number-cell payment-value">${formatNum(totalPayment)}</td>
                    <td class="action-cell">
                        <button type="button" class="delete-btn" data-bill="${escapeHtml(encodeURIComponent(key))}" onclick="requestDelete(event,this)" aria-label="Delete bill ${escapeHtml(displayBillNo)}" title="Delete bill ${escapeHtml(displayBillNo)}">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
                        </button>
                    </td>
                </tr>
            `;
        });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>HRS DRAFT INVOICE HUB (LIVE MONITOR)</title>
    <style>
        :root {
            color-scheme:dark;
            --page:#090d14;
            --bar:#0c111a;
            --panel:#0f1621;
            --panel-raised:#131c28;
            --row:#151f2c;
            --row-hover:#192737;
            --border:#283647;
            --border-bright:#3a4a5d;
            --text:#f4f7fb;
            --text-soft:#b7c2d0;
            --muted:#748195;
            --cyan:#29c7e8;
            --cyan-soft:#8be5f6;
            --green:#45d99a;
            --amber:#f7bd42;
            --coral:#ff5c70;
            --radius:8px;
            --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
            --mono:"Cascadia Code","SFMono-Regular",Consolas,"Liberation Mono",monospace;
        }
        *, *::before, *::after { box-sizing:border-box; }
        [hidden] { display:none !important; }
        html { background:var(--page); }
        body {
            min-width:320px;
            min-height:100vh;
            margin:0;
            padding:0 0 36px;
            background:var(--page);
            color:var(--text);
            font-family:var(--font);
            letter-spacing:0;
        }
        button, a { -webkit-tap-highlight-color:transparent; }
        button { font:inherit; }
        svg { display:block; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.8; }
        .topbar {
            min-height:76px;
            display:flex;
            align-items:center;
            gap:18px;
            padding:12px 28px;
            background:var(--bar);
            border-bottom:1px solid var(--border);
            position:sticky;
            top:0;
            z-index:20;
            box-shadow:0 12px 32px rgba(0,0,0,.18);
        }
        .brand { display:flex; align-items:center; gap:14px; min-width:0; }
        .logo-box {
            width:42px;
            height:42px;
            display:grid;
            place-items:center;
            flex:0 0 auto;
            border:1px solid var(--cyan);
            border-radius:8px;
            background:#0a111b;
            box-shadow:inset 0 0 0 1px rgba(41,199,232,.08);
        }
        .logo-text { color:var(--cyan); font:800 12px var(--mono); }
        .brand-copy { min-width:0; }
        .topbar-title {
            color:var(--text);
            font-size:15px;
            font-weight:760;
            line-height:1.25;
            text-transform:uppercase;
            white-space:nowrap;
        }
        .topbar-sub {
            margin-top:4px;
            color:var(--cyan);
            font:650 9px/1 var(--mono);
            text-transform:uppercase;
            letter-spacing:.12em;
            white-space:nowrap;
        }
        .topbar-divider { width:1px; height:40px; margin:0 10px; background:var(--border); flex:0 0 auto; }
        .monitor-meta { display:flex; align-items:center; gap:14px; min-width:0; }
        .live-state {
            height:32px;
            display:inline-flex;
            align-items:center;
            gap:8px;
            padding:0 11px;
            border:1px solid var(--border-bright);
            border-radius:7px;
            color:${invoiceStore.size ? 'var(--green)' : 'var(--amber)'};
            background:#101722;
            font:700 11px var(--mono);
            text-transform:uppercase;
        }
        .live-dot {
            width:8px;
            height:8px;
            border-radius:50%;
            background:currentColor;
            box-shadow:0 0 0 4px ${invoiceStore.size ? 'rgba(69,217,154,.09)' : 'rgba(247,189,66,.09)'};
        }
        .last-received { color:var(--muted); font-size:12px; white-space:nowrap; }
        .last-received strong { color:var(--text-soft); font-weight:650; font-variant-numeric:tabular-nums; }
        .container { width:100%; max-width:1920px; margin:0 auto; padding:28px; }
        .table-panel {
            overflow:hidden;
            background:var(--panel);
            border:1px solid var(--border);
            border-radius:var(--radius);
            box-shadow:0 20px 60px rgba(0,0,0,.22);
        }
        .table-toolbar {
            min-height:62px;
            display:flex;
            align-items:center;
            gap:12px;
            padding:0 18px;
            border-bottom:1px solid var(--border);
            background:var(--panel);
        }
        .broadcast-icon { width:20px; height:20px; color:var(--cyan); }
        .table-title {
            color:var(--text);
            font-size:13px;
            font-weight:750;
            text-transform:uppercase;
        }
        .record-count {
            min-width:68px;
            height:25px;
            display:inline-flex;
            align-items:center;
            justify-content:center;
            padding:0 9px;
            border:1px solid rgba(41,199,232,.42);
            border-radius:6px;
            background:rgba(41,199,232,.08);
            color:var(--cyan-soft);
            font:700 10px var(--mono);
            text-transform:uppercase;
        }
        .toolbar-updated { margin-left:auto; color:var(--muted); font-size:11px; white-space:nowrap; }
        .toolbar-updated strong { color:var(--text-soft); font-weight:650; font-variant-numeric:tabular-nums; }
        .bulk-actions {
            display:flex;
            align-items:center;
            gap:10px;
            margin-left:6px;
            padding-left:16px;
            border-left:1px solid var(--border);
        }
        .selection-count { color:var(--text-soft); font:650 11px var(--mono); white-space:nowrap; }
        .bulk-delete-btn {
            height:32px;
            display:inline-flex;
            align-items:center;
            gap:7px;
            padding:0 11px;
            border:1px solid rgba(255,92,112,.46);
            border-radius:6px;
            background:rgba(255,92,112,.08);
            color:#ff91a0;
            font-size:11px;
            font-weight:750;
            cursor:pointer;
            transition:background .16s ease,border-color .16s ease,color .16s ease,transform .14s ease;
        }
        .bulk-delete-btn svg { width:15px; height:15px; }
        .bulk-delete-btn:hover { border-color:var(--coral); background:rgba(255,92,112,.16); color:#ffc1c9; transform:translateY(-1px); }
        .table-scroll {
            width:100%;
            overflow-x:auto;
            overflow-y:hidden;
            scrollbar-width:none;
        }
        .table-scroll::-webkit-scrollbar { display:none; }
        table {
            width:100%;
            min-width:1580px;
            border-collapse:separate;
            border-spacing:0;
            background:var(--panel);
            font-size:13px;
            font-variant-numeric:tabular-nums;
        }
        th {
            height:46px;
            padding:0 13px;
            background:#0d141e;
            border-bottom:1px solid var(--border-bright);
            color:#92a0b2;
            font-size:10px;
            font-weight:700;
            text-align:left;
            text-transform:uppercase;
            white-space:nowrap;
        }
        td {
            height:68px;
            padding:0 13px;
            border-bottom:1px solid var(--border);
            background:var(--row);
            color:var(--text-soft);
            white-space:nowrap;
            transition:background .18s ease,color .18s ease,opacity .22s ease,transform .22s ease;
        }
        .invoice-row { position:relative; }
        .invoice-row td:first-child { box-shadow:inset 3px 0 0 transparent; }
        .invoice-row:hover td { background:var(--row-hover); }
        .invoice-row:hover td:first-child { box-shadow:inset 3px 0 0 var(--cyan); }
        .invoice-row.selected td { background:#18293a; }
        .invoice-row.selected td:first-child { box-shadow:inset 3px 0 0 var(--cyan); }
        .invoice-row.deleting td { opacity:0; transform:translateX(12px); }
        .select-cell { width:44px; padding:0 10px 0 16px; text-align:center; }
        .select-heading { width:44px; padding:0 10px 0 16px; text-align:center; }
        .row-select, .select-all {
            width:15px;
            height:15px;
            margin:0;
            accent-color:var(--cyan);
            cursor:pointer;
        }
        .time-cell { color:#9ba8b8; }
        .time-cell time { font-size:12px; }
        .row-signal {
            width:7px;
            height:7px;
            display:inline-block;
            margin-right:11px;
            border-radius:50%;
            background:var(--cyan);
            box-shadow:0 0 0 4px rgba(41,199,232,.07);
            vertical-align:1px;
        }
        .hotel-cell { color:var(--cyan); font-weight:750; }
        .room-cell { color:#dce3ec; }
        .bill-actions { display:flex; align-items:center; gap:8px; }
        .bill-link {
            height:38px;
            display:inline-flex;
            align-items:center;
            gap:10px;
            padding:0 11px;
            border:1px solid rgba(41,199,232,.28);
            border-radius:7px;
            color:#dcecf4;
            background:#121b26;
            font-weight:800;
            text-decoration:none;
            transition:border-color .16s ease,background .16s ease,color .16s ease,transform .16s ease;
        }
        .bill-link svg { width:15px; height:15px; color:#8491a2; transition:color .16s ease,transform .16s ease; }
        .bill-link:hover { border-color:rgba(41,199,232,.75); background:rgba(41,199,232,.09); color:var(--cyan-soft); transform:translateY(-1px); }
        .bill-link:hover svg { color:var(--cyan); transform:translate(1px,-1px); }
        .cheque-count {
            position:relative;
            width:34px;
            height:34px;
            display:inline-grid;
            place-items:center;
            border:1px solid rgba(69,217,154,.4);
            border-radius:7px;
            background:rgba(69,217,154,.1);
            color:#65e5ad;
            font:800 13px var(--mono);
            cursor:pointer;
            transition:border-color .16s ease,background .16s ease,color .16s ease,transform .16s ease;
        }
        .cheque-count:hover { border-color:rgba(69,217,154,.75); background:rgba(69,217,154,.17); color:#a1f2cb; transform:translateY(-1px); }
        .number-cell { text-align:right; color:#d7dee8; }
        .primary-value { color:#f2f5f9; font-weight:650; }
        .secondary-value { color:#91a0b3; }
        .gross-value { color:var(--green); font-weight:800; }
        .payment-value { color:var(--amber); font-weight:800; }
        .action-cell {
            width:72px;
            position:sticky;
            right:0;
            z-index:3;
            text-align:center;
            background:var(--row);
            box-shadow:-12px 0 24px rgba(9,13,20,.38);
        }
        th.action-heading { position:sticky; right:0; z-index:4; text-align:center; background:#0d141e; box-shadow:-12px 0 24px rgba(9,13,20,.38); }
        .invoice-row:hover .action-cell { background:var(--row-hover); }
        .delete-btn {
            position:relative;
            width:36px;
            height:36px;
            display:inline-grid;
            place-items:center;
            padding:0;
            border:1px solid var(--border-bright);
            border-radius:50%;
            background:#121923;
            color:#8d99aa;
            cursor:pointer;
            transition:background .16s ease,border-color .16s ease,color .16s ease,transform .14s ease;
        }
        .delete-btn svg { width:17px; height:17px; }
        .delete-btn:hover { border-color:rgba(255,92,112,.7); background:rgba(255,92,112,.1); color:var(--coral); transform:translateY(-1px); }
        .delete-btn:active, .bill-link:active, .cheque-count:active { transform:scale(.96); }
        .delete-btn:disabled { cursor:wait; opacity:.48; transform:none; }
        .empty-row td { height:310px; padding:30px; text-align:center; background:var(--panel); }
        .empty-state { display:flex; flex-direction:column; align-items:center; gap:8px; color:var(--muted); }
        .empty-state strong { color:var(--text-soft); font-size:14px; }
        .empty-state span:last-child { font-size:12px; }
        .empty-icon { width:42px; height:42px; display:grid; place-items:center; margin-bottom:5px; border:1px solid var(--border); border-radius:50%; color:var(--cyan); background:#101822; }
        .empty-icon svg { width:20px; height:20px; }
        :focus-visible { outline:2px solid var(--cyan); outline-offset:3px; }
        .dashboard-toast {
            position:fixed;
            left:50%;
            bottom:28px;
            z-index:60;
            max-width:min(420px,calc(100vw - 32px));
            padding:11px 15px;
            border:1px solid var(--border-bright);
            border-radius:7px;
            background:#101722;
            color:#d7e0e9;
            font:650 11px var(--font);
            box-shadow:0 18px 50px rgba(0,0,0,.46);
            opacity:0;
            pointer-events:none;
            transform:translate(-50%,14px);
            transition:opacity .2s ease,transform .2s ease;
        }
        .dashboard-toast.visible { opacity:1; transform:translate(-50%,0); }
        .dashboard-toast.error { border-color:rgba(255,92,112,.55); color:#ff9ba8; }
        .modal-backdrop {
            position:fixed;
            inset:0;
            z-index:50;
            display:grid;
            place-items:center;
            padding:20px;
            background:rgba(3,6,10,.72);
            backdrop-filter:blur(7px);
            opacity:0;
            visibility:hidden;
            transition:opacity .18s ease,visibility .18s ease;
        }
        .modal-backdrop.visible { opacity:1; visibility:visible; }
        .confirm-dialog {
            width:min(420px,100%);
            overflow:hidden;
            border:1px solid var(--border-bright);
            border-radius:8px;
            background:#111923;
            box-shadow:0 28px 90px rgba(0,0,0,.58);
            transform:translateY(10px) scale(.98);
            transition:transform .18s ease;
        }
        .modal-backdrop.visible .confirm-dialog { transform:none; }
        .dialog-body { display:flex; gap:14px; padding:21px 21px 17px; }
        .dialog-icon { width:38px; height:38px; display:grid; place-items:center; flex:0 0 auto; border:1px solid rgba(255,92,112,.35); border-radius:50%; background:rgba(255,92,112,.09); color:var(--coral); }
        .dialog-icon svg { width:18px; height:18px; }
        .dialog-copy h2 { margin:1px 0 7px; color:var(--text); font-size:15px; line-height:1.3; }
        .dialog-copy p { margin:0; color:var(--muted); font-size:12px; line-height:1.55; }
        .dialog-copy strong { color:#ff9ba8; }
        .dialog-actions { display:flex; justify-content:flex-end; gap:9px; padding:13px 16px; border-top:1px solid var(--border); background:#0e151e; }
        .dialog-btn { height:34px; padding:0 14px; border:1px solid var(--border-bright); border-radius:6px; background:#151e29; color:var(--text-soft); font-size:11px; font-weight:700; cursor:pointer; transition:background .15s ease,border-color .15s ease,color .15s ease; }
        .dialog-btn:hover { background:#1b2633; color:var(--text); }
        .dialog-btn.danger { border-color:rgba(255,92,112,.55); background:rgba(255,92,112,.1); color:#ff8998; }
        .dialog-btn.danger:hover { border-color:var(--coral); background:rgba(255,92,112,.18); color:#ffc0c8; }
        @media (max-width:760px) {
            .topbar { min-height:68px; padding:10px 14px; gap:10px; }
            .logo-box { width:38px; height:38px; }
            .topbar-title { font-size:12px; }
            .topbar-divider { margin:0 2px; height:34px; }
            .monitor-meta { margin-left:auto; }
            .last-received { display:none; }
            .live-state { height:29px; padding:0 9px; font-size:9px; }
            .container { padding:16px 12px; }
            .table-toolbar { min-height:56px; padding:0 13px; }
            .toolbar-updated { display:none; }
            .bulk-actions { margin-left:auto; padding-left:10px; }
            .selection-count { display:none; }
            .bulk-delete-btn span { display:none; }
            .bulk-delete-btn { width:32px; padding:0; justify-content:center; }
            .action-cell, th.action-heading { position:static; box-shadow:none; }
        }
        @media (max-width:480px) {
            .topbar-sub { display:none; }
            .topbar-divider { display:none; }
            .table-title { font-size:11px; }
            .record-count { min-width:auto; }
        }
        @media (prefers-reduced-motion:reduce) {
            *, *::before, *::after { scroll-behavior:auto !important; transition-duration:.01ms !important; animation-duration:.01ms !important; }
        }
    </style>
</head>
<body>
    <div class="topbar">
        <div class="brand">
            <div class="logo-box"><span class="logo-text">NNK</span></div>
            <div class="brand-copy">
                <div class="topbar-title">HRS Draft Invoice Hub</div>
                <div class="topbar-sub">Vibecoded by NNK</div>
            </div>
        </div>
        <div class="topbar-divider"></div>
        <div class="monitor-meta">
            <div class="live-state"><span class="live-dot" aria-hidden="true"></span>${monitorState}</div>
            <div class="last-received">Last received: <strong>${escapeHtml(lastReceived)}</strong></div>
        </div>
    </div>
    <div class="container">
        <div class="table-panel">
            <div class="table-toolbar">
                <svg class="broadcast-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8a7 7 0 0 0 0 8"/><path d="M19 8a7 7 0 0 1 0 8"/><path d="M8.5 10.5a3.5 3.5 0 0 0 0 3"/><path d="M15.5 10.5a3.5 3.5 0 0 1 0 3"/><circle cx="12" cy="12" r="1.5"/><path d="M12 13.5V21"/></svg>
                <span class="table-title">Live Transactions</span>
                <span class="record-count" id="recordCount" aria-live="polite">${invoiceStore.size} record${invoiceStore.size === 1 ? '' : 's'}</span>
                <div class="bulk-actions" id="bulkActions" hidden>
                    <span class="selection-count" id="selectionCount">0 selected</span>
                    <button type="button" class="bulk-delete-btn" onclick="requestBulkDelete()" title="Delete selected invoices">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
                        <span>Delete selected</span>
                    </button>
                </div>
                <span class="toolbar-updated">Updated <strong>${escapeHtml(lastReceived)}</strong></span>
            </div>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th class="select-heading">
                                <input type="checkbox" class="select-all" id="selectAll" aria-label="Select all invoices" onchange="toggleSelectAll(this.checked)">
                            </th>
                            <th>Time Recv</th>
                            <th>Hotel</th>
                            <th>Room</th>
                            <th>Bill Number</th>
                            <th style="text-align:right;">Total Net</th>
                            <th style="text-align:right;">Svc 8%</th>
                            <th style="text-align:right;">Svc 10%</th>
                            <th style="text-align:right;">Vat 8%</th>
                            <th style="text-align:right;">Vat 10%</th>
                            <th style="text-align:right;">Vat 5%</th>
                            <th style="text-align:right;">Sct 30%</th>
                            <th style="text-align:right;">Sct 20%</th>
                            <th style="text-align:right;">Total Gross</th>
                            <th style="text-align:right;">Tip</th>
                            <th style="text-align:right;">Paid Out</th>
                            <th style="text-align:right;">Rounding</th>
                            <th style="text-align:right;">Total Payment</th>
                            <th class="action-heading">Action</th>
                        </tr>
                    </thead>
                    <tbody id="invoiceRows">${rowsHtml}</tbody>
                </table>
            </div>
        </div>
    </div>
    <div class="dashboard-toast" id="dashboardToast" role="status" aria-live="polite"></div>
    <div class="modal-backdrop" id="deleteModal" role="presentation" onclick="handleBackdropClick(event)">
        <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="deleteTitle" aria-describedby="deleteDescription">
            <div class="dialog-body">
                <div class="dialog-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
                </div>
                <div class="dialog-copy">
                    <h2 id="deleteTitle">Delete draft invoice?</h2>
                    <p id="deleteDescription"><span id="deleteMessagePrefix">Bill</span> <strong id="deleteBillNumber"></strong> will be removed from the live cache. This action cannot be undone.</p>
                </div>
            </div>
            <div class="dialog-actions">
                <button type="button" class="dialog-btn" id="cancelDelete" onclick="closeDeleteDialog()">Cancel</button>
                <button type="button" class="dialog-btn danger" id="confirmDelete" onclick="confirmDeleteInvoices()">Delete invoice</button>
            </div>
        </div>
    </div>
    <script>
        let pendingDeleteBills = [];
        let pendingDeleteFocus = null;

        function showDashboardToast(message, isError) {
            const toast = document.getElementById('dashboardToast');
            toast.textContent = message;
            toast.classList.toggle('error', !!isError);
            toast.classList.add('visible');
            clearTimeout(window.dashboardToastTimer);
            window.dashboardToastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
        }

        function refreshRecordCount() {
            const count = document.querySelectorAll('.invoice-row').length;
            document.getElementById('recordCount').textContent = count + ' record' + (count === 1 ? '' : 's');
            if (count === 0) {
                document.getElementById('invoiceRows').innerHTML = '<tr class="empty-row"><td colspan="19"><div class="empty-state"><span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 16 0"/><path d="M7 12a5 5 0 0 1 10 0"/><path d="M10 12a2 2 0 0 1 4 0"/><path d="M12 15v5"/></svg></span><strong>Waiting for draft invoices</strong><span>New connector transactions will appear here automatically.</span></div></td></tr>';
            }
            syncSelectionState();
        }

        function openChequeDetails(event, encodedBill) {
            event.preventDefault();
            event.stopPropagation();
            window.open('/invoice/' + encodedBill + '/cheques', '_blank', 'noopener');
        }

        function getRowCheckboxes() {
            return Array.from(document.querySelectorAll('.row-select'));
        }

        function syncSelectionState() {
            const checkboxes = getRowCheckboxes();
            const selected = checkboxes.filter(checkbox => checkbox.checked);
            const selectAll = document.getElementById('selectAll');
            selectAll.checked = checkboxes.length > 0 && selected.length === checkboxes.length;
            selectAll.indeterminate = selected.length > 0 && selected.length < checkboxes.length;

            for (const checkbox of checkboxes) {
                checkbox.closest('.invoice-row').classList.toggle('selected', checkbox.checked);
            }

            document.getElementById('selectionCount').textContent = selected.length + ' selected';
            document.getElementById('bulkActions').hidden = selected.length === 0;
        }

        function toggleSelectAll(checked) {
            for (const checkbox of getRowCheckboxes()) checkbox.checked = checked;
            syncSelectionState();
        }

        function getBillLabel(billNo) {
            const row = document.querySelector('.invoice-row[data-bill="' + CSS.escape(billNo) + '"]');
            return row && row.dataset.billLabel ? row.dataset.billLabel : billNo;
        }

        function openDeleteDialog(billNos, focusTarget) {
            pendingDeleteBills = billNos.filter(Boolean);
            pendingDeleteFocus = focusTarget || null;
            if (pendingDeleteBills.length === 0) return;

            const isBulk = pendingDeleteBills.length > 1;
            document.getElementById('deleteTitle').textContent = isBulk ? 'Delete selected invoices?' : 'Delete draft invoice?';
            document.getElementById('deleteMessagePrefix').textContent = isBulk ? 'The selected' : 'Bill';
            document.getElementById('deleteBillNumber').textContent = isBulk
                ? pendingDeleteBills.length + ' invoices'
                : getBillLabel(pendingDeleteBills[0]);
            document.getElementById('confirmDelete').textContent = isBulk ? 'Delete invoices' : 'Delete invoice';
            document.getElementById('deleteModal').classList.add('visible');
            document.body.style.overflow = 'hidden';
            requestAnimationFrame(() => document.getElementById('cancelDelete').focus());
        }

        function requestDelete(event, button) {
            event.preventDefault();
            event.stopPropagation();
            openDeleteDialog([decodeURIComponent(button.dataset.bill || '')], button);
        }

        function requestBulkDelete() {
            const selected = getRowCheckboxes().filter(checkbox => checkbox.checked);
            openDeleteDialog(selected.map(checkbox => checkbox.value), document.querySelector('.bulk-delete-btn'));
        }

        function closeDeleteDialog() {
            document.getElementById('deleteModal').classList.remove('visible');
            document.body.style.overflow = '';
            if (pendingDeleteFocus) pendingDeleteFocus.focus();
            pendingDeleteFocus = null;
            pendingDeleteBills = [];
        }

        function handleBackdropClick(event) {
            if (event.target === event.currentTarget) closeDeleteDialog();
        }

        async function confirmDeleteInvoices() {
            const billNos = [...pendingDeleteBills];
            if (billNos.length === 0) return;

            const confirmButton = document.getElementById('confirmDelete');
            const isBulk = billNos.length > 1;
            confirmButton.disabled = true;
            confirmButton.textContent = 'Deleting...';
            for (const button of document.querySelectorAll('.delete-btn')) {
                const billNo = decodeURIComponent(button.dataset.bill || '');
                if (billNos.includes(billNo)) button.disabled = true;
            }

            try {
                const response = isBulk
                    ? await fetch('/api/invoices', {
                        method:'DELETE',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ billNos })
                    })
                    : await fetch('/api/invoices/' + encodeURIComponent(billNos[0]), { method:'DELETE' });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(result.Message || 'Unable to delete this invoice.');
                }

                const deletedBills = isBulk
                    ? toClientArray(result.Result && result.Result.deleted)
                    : billNos;
                document.getElementById('deleteModal').classList.remove('visible');
                document.body.style.overflow = '';
                pendingDeleteFocus = null;
                pendingDeleteBills = [];

                const rows = Array.from(document.querySelectorAll('.invoice-row'))
                    .filter(row => deletedBills.includes(row.dataset.bill));
                for (const row of rows) row.classList.add('deleting');
                setTimeout(() => {
                    for (const row of rows) row.remove();
                    refreshRecordCount();
                }, 210);
                showDashboardToast(
                    deletedBills.length === 1
                        ? 'Bill ' + deletedBills[0] + ' deleted.'
                        : deletedBills.length + ' invoices deleted.'
                );
            } catch (error) {
                for (const button of document.querySelectorAll('.delete-btn')) button.disabled = false;
                showDashboardToast(error.message || 'Unable to delete this invoice.', true);
            } finally {
                confirmButton.disabled = false;
                if (pendingDeleteBills.length > 0) {
                    confirmButton.textContent = pendingDeleteBills.length > 1 ? 'Delete invoices' : 'Delete invoice';
                }
            }
        }

        function toClientArray(value) {
            if (!value) return [];
            return Array.isArray(value) ? value : [value];
        }

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && document.getElementById('deleteModal').classList.contains('visible')) {
                closeDeleteDialog();
            }
        });

        const dashboardEvents = new EventSource('/api/dashboard/events');
        dashboardEvents.onmessage = event => {
            try {
                const update = JSON.parse(event.data);
                if (update.type === 'invoice-received') {
                    window.location.reload();
                }
            } catch (error) {
                console.warn('Ignored an invalid dashboard update event.');
            }
        };
    </script>
</body>
</html>`);
});

app.get('/legacy-dashboard', (req, res) => {
    let rowsHtml = '';
    if (invoiceStore.size === 0) {
        rowsHtml = `<tr><td colspan="17" style="text-align:center;color:#6b7280;padding:40px 10px;font-style:italic;">No inbound connector telemetry discovered yet. Stream real-time data to port ${PORT}...</td></tr>`;
    } else {
        invoiceStore.forEach((value, key) => {
            const d = value.data;
            const sum = getSummaryInfo(d);
            const hotelCode = getHotelCode(d);
            const roomNo = getRoomNo(d);
            const chequeCount = getChequeDetails(d).allChequeDetails.length;

            // Calculate FLIP Payment values
            let totalPayment = 0;
            for (const b of toArray(d.RevenueBucketInfo || d.FolioInfo?.RevenueBucketInfo)) {
                if (b.BucketType === "FLIP_PAY_TYPE") {
                    totalPayment += parseFloat(b.BucketCodeTotalGross || 0);
                }
            }

            rowsHtml += `
                <tr>
                    <td style="color:#6b7280;font-size:11px;">${value.timestamp}</td>
                    <td style="font-weight:600;color:#38bdf8;">${info.HotelCode || '—'}</td>
                    <td>${info.RoomNo || '—'}</td>
                    <td style="position:relative;font-weight:bold;color:#f43f5e;">
                        <a href="/invoice/${key}" target="_blank" style="color:inherit;text-decoration:none;border-bottom:1px dashed #f43f5e;padding-bottom:1px;transition:all 0.2s;" onmouseover="this.style.color='#f43f5e';this.style.borderBottomStyle='solid';" onmouseout="this.style.color='inherit';this.style.borderBottomStyle='dashed';">
                            ${key}
                        </a>${chequeCount > 0 ? `<span onclick="window.open('/invoice/${key}?showCheques=true','_blank')" style="vertical-align:super;font-size:10px;font-weight:900;color:#34d399;background:rgba(52,211,153,0.15);padding:1px 4px;border-radius:4px;margin-left:2px;cursor:pointer;transition:all 0.2s;" title="View ${chequeCount} associated unique POS Cheques">${chequeCount}</span>` : ''}
                    </td>
                    <td style="text-align:right;">${formatNum(sum.TotalNet)}</td>
                    <td style="text-align:right;color:#94a3b8;">${formatNum(sum.TotalSvc8)}</td>
                    <td style="text-align:right;color:#94a3b8;">${formatNum(sum.TotalSvc10)}</td>
                    <td style="text-align:right;color:#94a3b8;">${formatNum(sum.TotalVat8)}</td>
                    <td style="text-align:right;color:#94a3b8;">${formatNum(sum.TotalVat10)}</td>
                    <td style="text-align:right;color:#94a3b8;">${formatNum(sum.TotalVat5)}</td>
                    <td style="text-align:right;color:#e2e8f0;">${formatNum(sum.TotalSct30)}</td>
                    <td style="text-align:right;color:#e2e8f0;">${formatNum(sum.TotalSct20)}</td>
                    <td style="text-align:right;font-weight:600;color:#34d399;">${formatNum(sum.TotalGross)}</td>
                    <td style="text-align:right;">${formatNum(sum.TotalTip)}</td>
                    <td style="text-align:right;">${formatNum(sum.TotalPaidOut)}</td>
                    <td style="text-align:right;color:#a1a1aa;">${formatNum(sum.TotalRounding)}</td>
                    <td style="text-align:right;font-weight:700;color:#fbbf24;background:rgba(251,191,36,0.03);">${formatNum(totalPayment)}</td>
                </tr>
            `;
        });
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HRS DRAFT INVOICE HUB (LIVE MONITOR)</title>
    <style>
        body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:#0f172a; color:#f1f5f9; margin:0; padding:24px; }
        .container { max-width:1600px; margin:0 auto; }
        .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid #334155; padding-bottom:16px; }
        h1 { margin:0; font-size:22px; letter-spacing:-0.5px; background:linear-gradient(to right, #34d399, #0ea5e9); -webkit-background-clip:text; -webkit-text-fill-color:transparent; display:flex; align-items:center; gap:8px; }
        .badge { background:#1e293b; border:1px solid #475569; padding:6px 12px; border-radius:6px; font-size:12px; font-family:monospace; color:#34d399; }
        table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:8px; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1); font-size:13px; }
        th { background:#0f172a; color:#94a3b8; font-weight:600; text-align:left; padding:12px 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; border-bottom:2px solid #334155; }
        td { padding:10px; border-bottom:1px solid #334155; color:#cbd5e1; white-space:nowrap; }
        tr:hover td { background:rgba(30,41,59,0.5); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span>⚡</span> HRS DRAFT INVOICE HUB <span style="font-size:12px;color:#6b7280;font-weight:normal;">Vibecoded by NNK</span></h1>
            <div class="badge">LISTENING ON PORT : ${PORT}</div>
        </div>
        <table style="width:100%;">
            <thead>
                <tr>
                    <th>Time Recv</th>
                    <th>Hotel</th>
                    <th>Room</th>
                    <th>Bill Number</th>
                    <th style="text-align:right;">Total Net</th>
                    <th style="text-align:right;">Svc 8%</th>
                    <th style="text-align:right;">Svc 10%</th>
                    <th style="text-align:right;">Vat 8%</th>
                    <th style="text-align:right;">Vat 10%</th>
                    <th style="text-align:right;">Vat 5%</th>
                    <th style="text-align:right;">Sct 30%</th>
                    <th style="text-align:right;">Sct 20%</th>
                    <th style="text-align:right;">Total Gross</th>
                    <th style="text-align:right;">Tip</th>
                    <th style="text-align:right;">Paid Out</th>
                    <th style="text-align:right;">Rounding</th>
                    <th style="text-align:right;">Total Payment</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    </div>
</body>
</html>`);
});

// ==========================================
// DRAFT VIEWING SPECIFIC INVOICE RENDERING
// ==========================================
app.get('/invoice/:billNo/cheques', (req, res) => {
    const { billNo } = req.params;
    const record = invoiceStore.get(billNo.toString());

    if (!record) {
        return res.status(404).send(`<body style="background:#0f172a;color:#f43f5e;font-family:sans-serif;padding:40px;text-align:center;">
            <h3>404 TRANSACTION RECORD NOT CACHED</h3>
            <p style="color:#94a3b8">The Bill Number sequence <b>${escapeHtml(billNo)}</b> was not captured in memory.</p>
        </body>`);
    }

    const displayBillNo = getDisplayBillNo(billNo, record);
    const allChequeDetails = getChequeDetails(record.data).allChequeDetails;
    const chequeBoxes = allChequeDetails.length
        ? allChequeDetails.map(item => {
            let decoded = '';
            try {
                decoded = Buffer.from(item.b64, 'base64').toString('utf8');
            } catch (e) {
                decoded = String(item.b64 || '');
            }
            return `<article class="cheque-box"><span class="cheque-head">CHEQUE NO: ${escapeHtml(item.no)}</span><pre>${escapeHtml(decoded)}</pre></article>`;
        }).join('')
        : '<div class="empty-state">No cheque details found for this bill.</div>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>All Cheque Details - Bill ${escapeHtml(displayBillNo)}</title>
    <style>
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
        .topbar{height:56px;background:#111827;border-bottom:1px solid #334155;display:flex;align-items:center;padding:0 24px;gap:16px;position:sticky;top:0;z-index:10;box-shadow:0 2px 12px rgba(0,0,0,.4)}
        .logo-box{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#34d399,#0ea5e9);padding:2px;flex-shrink:0}
        .logo-inner{width:100%;height:100%;background:#0f172a;border-radius:8px;display:flex;align-items:center;justify-content:center}
        .logo-text{color:#22d3ee;font:900 11px monospace}
        .topbar-title{color:#2dd4bf;font-weight:800;letter-spacing:.12em;font-size:13px;text-transform:uppercase}
        .topbar-sub{font:600 9px monospace;color:#64748b;text-transform:uppercase;letter-spacing:.15em}
        .topbar-divider{width:1px;height:28px;background:#334155;margin:0 8px}
        .bill-badge{display:flex;align-items:center;gap:8px;background:#1e293b;border:1px solid #475569;border-radius:999px;padding:4px 14px;font:700 11px monospace;color:#34d399}
        .bill-badge .dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 6px #10b981}
        .page{max-width:1800px;margin:0 auto;padding:24px}
        .page-header{display:flex;align-items:center;gap:10px;margin-bottom:18px}
        .page-title{font:700 10px monospace;color:#94a3b8;text-transform:uppercase;letter-spacing:.12em}
        .count{background:#1e293b;border:1px solid #475569;color:#38bdf8;font:700 9px monospace;padding:2px 8px;border-radius:999px}
        .cheque-container{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
        .cheque-box{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;box-shadow:0 10px 24px rgba(0,0,0,.2);width:max-content;max-width:100%;transition:border-color .15s ease,transform .15s ease}
        .cheque-box:hover{border-color:#475569;transform:translateY(-1px)}
        .cheque-head{color:#34d399;font:700 11px monospace;display:block;border-bottom:1px dashed #475569;padding-bottom:9px;margin-bottom:11px}
        pre{font:12px/1.5 monospace;color:#cbd5e1;white-space:pre;word-break:normal;overflow:auto;max-width:100%}
        .empty-state{width:100%;padding:44px 16px;text-align:center;color:#64748b;background:#111827;border:1px solid #334155;border-radius:8px;font-style:italic}
        @media(max-width:700px){.topbar{padding:0 14px;gap:10px}.topbar-divider{margin:0 2px}.bill-badge{display:none}.page{padding:18px 14px}.cheque-box{width:100%}}
    </style>
</head>
<body>
    <div class="topbar">
        <div class="logo-box"><div class="logo-inner"><span class="logo-text">NNK</span></div></div>
        <div><div class="topbar-title">HRS DRAFT INVOICE HUB</div><div class="topbar-sub">All Cheque Details</div></div>
        <div class="topbar-divider"></div>
        <div class="bill-badge"><span class="dot"></span><span>Bill ${escapeHtml(displayBillNo)}</span></div>
    </div>
    <main class="page">
        <div class="page-header">
            <span class="page-title">All Cheque Details</span>
            <span class="count">${allChequeDetails.length} receipt${allChequeDetails.length === 1 ? '' : 's'}</span>
        </div>
        <div class="cheque-container">${chequeBoxes}</div>
    </main>
</body>
</html>`);
});

app.get('/invoice/:billNo', (req, res) => {
    const { billNo } = req.params;
    const autoOpenCheques = req.query.showCheques === 'true';
    const record = invoiceStore.get(billNo.toString());

    if (!record) {
        return res.status(404).send(`<body style="background:#0f172a;color:#f43f5e;font-family:sans-serif;padding:40px;text-align:center;">
            <h3>404 TRANSACTION RECORD NOT CACHED</h3>
            <p style="color:#94a3b8">The Bill Number sequence <b>${escapeHtml(billNo)}</b> was not captured in memory. Stream a new transaction payload via your connector tool to automatically compile this page view.</p>
        </body>`);
    }

    const data = record.data;
    const di = data.DocumentInfo || data.FolioDeliveryInfo || data.FolioInfo?.FolioHeaderInfo || {};
    const ri = getReservationInfo(data);
    const ti = getSummaryInfo(data);
    const validPostings = getValidPostings(data);
    const { trxDescMap, articleDescMap, packageDescription } = buildDescriptionMaps(data);
    const { chequeMap, allChequeDetails } = getChequeDetails(data);
    const derivedBillDate = data.FolioInfo?.FolioHeaderInfo?.BillGenerationDate || di.BillGenerationDate || di.BusinessDateTime || '';

    const totalsData = [
        { label: 'Total Net',      value: ti.TotalNet,                              color: '#34d399', bg: 'rgba(16,185,129,0.08)' },
        { label: 'Total SVC8',     value: firstValue(ti.TotalSVC8, ti.TotalSvc8),    color: '#38bdf8', bg: 'rgba(56,189,248,0.06)' },
        { label: 'Total SVC10',    value: firstValue(ti.TotalSVC10, ti.TotalSvc10),  color: '#38bdf8', bg: 'rgba(56,189,248,0.06)' },
        { label: 'Total VAT8',     value: firstValue(ti.TotalVAT8, ti.TotalVat8),    color: '#e879f9', bg: 'rgba(232,121,249,0.06)' },
        { label: 'Total VAT10',    value: firstValue(ti.TotalVAT10, ti.TotalVat10),  color: '#e879f9', bg: 'rgba(232,121,249,0.06)' },
        { label: 'Total VAT5',     value: firstValue(ti.TotalVAT5, ti.TotalVat5),    color: '#e879f9', bg: 'rgba(232,121,249,0.06)' },
        { label: 'Total SCT30',    value: firstValue(ti.TotalSCT30, ti.TotalSct30),  color: '#fb923c', bg: 'rgba(251,146,60,0.06)' },
        { label: 'Total SCT20',    value: firstValue(ti.TotalSCT20, ti.TotalSct20),  color: '#fb923c', bg: 'rgba(251,146,60,0.06)' },
		{ label: 'Total Gross',    value: ti.TotalGross,                            color: '#34d399', bg: 'rgba(16,185,129,0.12)', bold: true, separator: true },
        { label: 'Total TIP',      value: firstValue(ti.TotalTIP, ti.TotalTip),      color: '#a1a1aa', bg: 'transparent' },
        { label: 'Total PaidOut',  value: ti.TotalPaidOut,                          color: '#a1a1aa', bg: 'transparent' },
        { label: 'Total Rounding', value: ti.TotalRounding,                         color: '#a1a1aa', bg: 'transparent' },
        
    ];

    let footerRowsHtml = '';
    for (const row of totalsData) {
        const sepStyle = row.separator ? 'border-top:1px solid #475569;' : '';
        const boldStyle = row.bold ? 'font-weight:700;font-size:13px;' : '';
        footerRowsHtml += `<tr style="background:${row.bg};"><td colspan="9" style="${sepStyle}${boldStyle}padding:6px 12px 6px 0;text-align:right;color:#94a3b8;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">${row.label}</td><td colspan="2" style="${sepStyle}${boldStyle}padding:6px 8px 6px 0;text-align:right;font-family:monospace;color:${row.color};">${formatNum(row.value, 2)}</td></tr>`;
    }

    const serialisedPostings = safeScriptJson(validPostings);
    const serialisedTrxDescMap = safeScriptJson(trxDescMap);
    const serialisedArtDescMap = safeScriptJson(articleDescMap);
    const serialisedPkgDesc = safeScriptJson(packageDescription);
    const serialisedChequeMap = safeScriptJson(chequeMap);
    const serialisedAllCheques = safeScriptJson(allChequeDetails);
    const hotelCode = getHotelCode(data);
    const roomNo = getRoomNo(data);
    const currentBillNo = getBillNo(data) || billNo;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Draft Invoice - BillNo ${escapeHtml(currentBillNo)}</title>
<style>
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { background:#0f172a; color:#e4e4e7; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:13px; min-height:100vh; padding-bottom:48px; }
  .topbar { height:56px; background:#111827; border-bottom:1px solid #334155; display:flex; align-items:center; padding:0 24px; gap:16px; position:sticky; top:0; z-index:10; box-shadow:0 2px 12px rgba(0,0,0,.4); }
  .logo-box { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,#34d399,#0ea5e9); padding:2px; flex-shrink:0; }
  .logo-inner { width:100%; height:100%; background:#0f172a; border-radius:8px; display:flex; align-items:center; justify-content:center; }
  .logo-text { color:#22d3ee; font-weight:900; font-family:monospace; font-size:11px; }
  .topbar-title { color:#2dd4bf; font-weight:800; letter-spacing:.12em; font-size:13px; text-transform:uppercase; }
  .topbar-sub { font-size:9px; color:#64748b; text-transform:uppercase; letter-spacing:.15em; font-weight:600; font-family:monospace; }
  .topbar-divider { width:1px; height:28px; background:#334155; margin:0 8px; }
  .topbar-badge { display:flex; align-items:center; gap:8px; background:#1e293b; border:1px solid #475569; border-radius:999px; padding:4px 14px; font-family:monospace; font-size:11px; }
  .topbar-badge .dot { width:7px; height:7px; border-radius:50%; background:#34d399; box-shadow:0 0 6px #10b981; }
  .topbar-badge .lbl { color:#94a3b8; font-weight:700; text-transform:uppercase; letter-spacing:.06em; font-size:9px; }
  .topbar-badge .val { color:#34d399; font-weight:700; }
  .topbar-right { margin-left:auto; display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
  .group-toggle,.print-btn { display:flex; align-items:center; gap:8px; background:#1e293b; border:1px solid #475569; border-radius:8px; padding:6px 14px; font-size:11px; font-weight:700; cursor:pointer; text-transform:uppercase; letter-spacing:.05em; color:#cbd5e1; transition:background .15s,border-color .15s,color .15s; user-select:none; }
  .group-toggle:hover,.print-btn:hover { background:#334155; color:#f8fafc; }
  .group-toggle.on { background:rgba(56,189,248,0.12); border-color:rgba(56,189,248,0.45); color:#38bdf8; }
  .group-toggle .toggle-pip { width:26px; height:14px; border-radius:999px; background:#475569; position:relative; transition:background .2s; flex-shrink:0; }
  .group-toggle .toggle-pip::after { content:''; position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%; background:#94a3b8; transition:transform .2s,background .2s; }
  .group-toggle.on .toggle-pip { background:rgba(56,189,248,0.3); }
  .group-toggle.on .toggle-pip::after { transform:translateX(12px); background:#38bdf8; }
  .page { max-width:1400px; margin:0 auto; padding:24px 24px 0; }
  .draft-badge,.cheque-badge { display:inline-flex; align-items:center; gap:8px; background:rgba(251,191,36,0.08); border:1px solid rgba(251,191,36,0.25); color:#fbbf24; font-family:monospace; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; border-radius:6px; padding:4px 12px; margin-bottom:18px; }
  .cheque-badge { background:rgba(16,185,129,0.08); border-color:rgba(16,185,129,0.25); color:#34d399; margin-left:10px; cursor:pointer; transition:all .15s; }
  .cheque-badge:hover { background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.4); }
  .header-card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:20px 24px; margin-bottom:20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:18px 32px; }
  .hf-item { display:flex; flex-direction:column; gap:4px; min-width:0; }
  .hf-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; color:#64748b; font-family:monospace; }
  .hf-value { font-size:13px; font-weight:600; color:#e4e4e7; font-family:monospace; overflow-wrap:anywhere; }
  .hf-value.accent { color:#34d399; } .hf-value.sky { color:#38bdf8; } .hf-value.fuchsia { color:#e879f9; }
  .section-header,.totals-section-header { display:flex; align-items:center; gap:10px; padding:10px 16px; background:#0f172a; border:1px solid #334155; border-bottom:none; border-radius:12px 12px 0 0; }
  .section-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; color:#94a3b8; font-family:monospace; }
  .grouped-badge { display:none; align-items:center; gap:6px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25); color:#38bdf8; font-family:monospace; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; padding:2px 10px; border-radius:999px; }
  .grouped-badge.visible { display:flex; }
  .section-count { background:#1e293b; border:1px solid #475569; color:#cbd5e1; font-family:monospace; font-size:9px; font-weight:700; padding:2px 8px; border-radius:999px; transition:opacity .12s; }
  .section-count.updating { opacity:0; }
  .table-wrap,.totals-wrap { background:#1e293b; border:1px solid #334155; border-top:none; border-radius:0 0 12px 12px; overflow-x:auto; margin-bottom:20px; }
  .totals-wrap { overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:11.5px; }
  col.c-no { width:38px; } col.c-chk { width:140px; } col.c-date { width:92px; } col.c-tc { width:70px; } col.c-tcd { width:250px; } col.c-aid { width:70px; } col.c-adc { width:170px; } col.c-tax { width:64px; } col.c-qty { width:58px; } col.c-upr { width:92px; } col.c-amt { width:100px; }
  thead tr { background:#0f172a; }
  thead th { padding:10px 8px; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#93c5fd; font-family:monospace; border-bottom:1px solid #334155; white-space:nowrap; }
  thead th.r { text-align:right; }
  #postingsTbody { transition:opacity .12s ease; }
  #postingsTbody.fading { opacity:0; pointer-events:none; }
  .inv-row td { padding:8px; border-bottom:1px solid rgba(51,65,85,0.75); vertical-align:middle; white-space:nowrap; transition:background .15s; }
  .inv-row:last-child td { border-bottom:none; }
  .inv-row:hover td { background:rgba(255,255,255,0.035) !important; }
  .inv-row.grouped-row td { background:rgba(56,189,248,0.06); }
  .inv-row.grouped-row td:first-child { border-left:2px solid rgba(56,189,248,0.5); padding-left:6px; }
  .totals-section-header { margin-top:8px; }
  .totals-wrap table { font-size:12px; }
  .totals-wrap td { padding:7px 10px; border-bottom:1px solid rgba(51,65,85,0.55); }
  .totals-wrap tr:last-child td { border-bottom:none; }
  @media print {
    body { background:white; color:black; }
    .topbar,.print-btn,.draft-badge,.cheque-badge,.group-toggle { display:none !important; }
    .header-card,.table-wrap,.totals-wrap { border-color:#ccc !important; background:white !important; }
    thead th,.hf-label { color:#555 !important; }
    .hf-value,.inv-row td,.totals-wrap td { color:black !important; }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="logo-box"><div class="logo-inner"><span class="logo-text">NNK</span></div></div>
  <div><div class="topbar-title">HRS DRAFT INVOICE HUB</div><div class="topbar-sub">Vibecoded by NNK</div></div>
  <div class="topbar-divider"></div>
  <div class="topbar-badge"><div class="dot"></div><span class="lbl">Draft Invoice</span><span class="val">${escapeHtml(currentBillNo)}</span></div>
  <div class="topbar-right">
    <button class="group-toggle" id="packageGroupToggleBtn" onclick="setGroupingMode('package')"><div class="toggle-pip"></div><span>Group by Package &amp; Tax Rate</span></button>
    <button class="group-toggle" id="checkGroupToggleBtn" onclick="setGroupingMode('check')"><div class="toggle-pip"></div><span>Group by CheckNumber</span></button>
    <button class="print-btn" onclick="window.print()">Print</button>
  </div>
</div>

<div class="page">
  <div class="draft-badge">Draft Invoice</div>
  ${allChequeDetails.length > 0 ? `<div class="cheque-badge" onclick="openAllChequeDetails()">View ${allChequeDetails.length} Cheque(s)</div>` : ''}

  <div class="header-card">
    <div class="hf-item"><span class="hf-label">Hotel Code</span><span class="hf-value accent">${escapeHtml(hotelCode)}</span></div>
    <div class="hf-item"><span class="hf-label">Bill No</span><span class="hf-value accent" style="font-size:16px;">${escapeHtml(currentBillNo)}</span></div>
    <div class="hf-item"><span class="hf-label">Bill Gen Date</span><span class="hf-value">${escapeHtml(formatDate(derivedBillDate))}</span></div>
    <div class="hf-item"><span class="hf-label">Confirmation No</span><span class="hf-value sky">${escapeHtml(ri.ConfirmationNo)}</span></div>
    <div class="hf-item"><span class="hf-label">Room No</span><span class="hf-value sky">${escapeHtml(roomNo)}</span></div>
    <div class="hf-item"><span class="hf-label">Arrival Date</span><span class="hf-value">${escapeHtml(formatDate(ri.ArrivalDate))}</span></div>
    <div class="hf-item"><span class="hf-label">Departure Date</span><span class="hf-value">${escapeHtml(formatDate(ri.DepartureDate))}</span></div>
    <div class="hf-item"><span class="hf-label">RESV_NAME_ID</span><span class="hf-value fuchsia">${escapeHtml(ri.ResvNameID)}</span></div>
  </div>

  <div class="section-header">
    <span class="section-title">Posting Details</span>
    <span class="section-count" id="postingCount">${validPostings.length} items</span>
    <span class="grouped-badge" id="groupedBadge">Grouped</span>
  </div>
  <div class="table-wrap">
    <table>
      <colgroup>
        <col class="c-no"><col class="c-chk"><col class="c-date"><col class="c-tc">
        <col class="c-tcd"><col class="c-aid"><col class="c-adc">
        <col class="c-tax"><col class="c-qty"><col class="c-upr"><col class="c-amt">
      </colgroup>
      <thead>
        <tr>
          <th style="width:36px;text-align:center;">No.</th>
          <th>Check No.</th>
          <th>Trx Date</th>
          <th>Trx Code</th>
          <th>Trx Code Desc</th>
          <th>Article ID</th>
          <th>Article Desc</th>
          <th class="r">Tax Rate</th>
          <th class="r">Quantity</th>
          <th class="r">Unit Price</th>
          <th class="r">Amount</th>
        </tr>
      </thead>
      <tbody id="postingsTbody"></tbody>
    </table>
  </div>

  <div class="totals-section-header"><span class="section-title">Invoice Totals</span></div>
  <div class="totals-wrap"><table><tbody>${footerRowsHtml}</tbody></table></div>
</div>

<script>
  const INV_POSTINGS = ${serialisedPostings};
  const INV_TRX_DESC = ${serialisedTrxDescMap};
  const INV_ART_DESC = ${serialisedArtDescMap};
  const INV_PKG_DESC = ${serialisedPkgDesc};
  const INV_CHEQUE_MAP = ${serialisedChequeMap};
  const INV_ALL_CHEQUES = ${serialisedAllCheques};
  let groupByPackage = false;
  let groupByCheckNumber = false;

  function f(v) { return (v == null || v === '') ? '--' : String(v); }
  function fn(v) { const n = parseFloat(v); if (isNaN(n)) return '--'; return n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function upr(amt, qty) { const q = num(qty); if (!q) return null; return num(amt) / q; }
  function sumAmount(rows) { return rows.reduce((s, p) => s + num(p.HRSAmount), 0); }
  function sameOrMixed(rows, fieldOrGetter) {
    const getVal = typeof fieldOrGetter === 'function' ? fieldOrGetter : (p) => p[fieldOrGetter];
    const vals = [...new Set(rows.map(getVal).filter((v) => v != null && v !== '').map(String))];
    return vals.length <= 1 ? (vals[0] || '') : 'Mixed';
  }
  function hasPackageValue(p) { const v = p && p.TrxNoAgainstPackage; return v != null && String(v).trim() !== '' && String(v).trim() !== '0'; }
  function chequeKey(p) { return p.ChequeNumber || p.CheckNo || p.ChequeNo || p.TrxNo || ''; }
  function hasCheckNumberValue(p) { const v = chequeKey(p || {}); return v != null && String(v).trim() !== ''; }
  function updateGroupingButtons() {
    document.getElementById('packageGroupToggleBtn').classList.toggle('on', groupByPackage);
    document.getElementById('checkGroupToggleBtn').classList.toggle('on', groupByCheckNumber);
  }
  function getGroupingLabel() {
    if (groupByPackage && groupByCheckNumber) return 'Grouped by Package + Tax Rate + CheckNumber';
    if (groupByPackage) return 'Grouped by Package + Tax Rate';
    if (groupByCheckNumber) return 'Grouped by CheckNumber';
    return 'Grouped';
  }

  function openAllChequeDetails() {
    const win = window.open('', '_blank');
    if (!win) { showToast('Pop-up blocked. Please allow pop-ups to view cheque details.'); return; }
    win.document.open();
    win.document.write(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>All Cheque Details</title><style>
      *{box-sizing:border-box;margin:0;padding:0;}body{background:#0f172a;color:#e4e4e7;font-family:monospace;font-size:12px;padding:24px;}
      .topbar{height:48px;background:#111827;border-bottom:1px solid #334155;display:flex;align-items:center;padding:0 20px;gap:12px;margin:-24px -24px 24px;font-size:11px;position:sticky;top:0;z-index:10;}
      .topbar-title{color:#34d399;font-weight:700;letter-spacing:.1em;text-transform:uppercase;}
      .cheque-container{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;}
      .cheque-box{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;line-height:1.5;color:#cbd5e1;white-space:pre;word-break:break-all;width:max-content;max-width:100%;overflow-x:auto;}
      .cheque-head{color:#34d399;font-weight:bold;margin-bottom:12px;display:block;border-bottom:1px dashed #334155;padding-bottom:8px;}
    </style></head><body><div class="topbar"><span class="topbar-title">All Cheque Details - \${INV_ALL_CHEQUES.length} Receipt(s)</span></div><div class="cheque-container">\`);
    INV_ALL_CHEQUES.forEach(item => {
      let decoded = 'Error decoding';
      try { decoded = decodeURIComponent(escape(atob(item.b64))); } catch(e) { try { decoded = atob(item.b64); } catch(err) {} }
      win.document.write(\`<div class="cheque-box"><span class="cheque-head">--- CHEQUE NO: \${esc(item.no)} ---</span>\\n\${esc(decoded)}</div>\`);
    });
    win.document.write('</div></body></html>');
    win.document.close();
  }

  function openChequeDetails(b64) {
    let decoded;
    try { decoded = atob(b64); } catch(e) { showToast('Failed to decode base64 ChequeDetails.'); return; }
    const win = window.open('', '_blank');
    if (!win) { showToast('Pop-up blocked. Please allow pop-ups to view cheque details.'); return; }
    const isHtml = /^\\s*<(!DOCTYPE|html)/i.test(decoded);
    win.document.open();
    if (isHtml) {
      win.document.write(decoded);
    } else {
      win.document.write(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cheque Details</title><style>
        *{box-sizing:border-box;margin:0;padding:0;}body{background:#0f172a;color:#e4e4e7;font-family:monospace;font-size:12px;padding:24px;}
        .topbar{height:48px;background:#111827;border-bottom:1px solid #334155;display:flex;align-items:center;padding:0 20px;gap:12px;margin:-24px -24px 24px;font-size:11px;}
        .topbar-title{color:#34d399;font-weight:700;letter-spacing:.1em;text-transform:uppercase;}
        pre{white-space:pre-wrap;word-break:break-all;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;line-height:1.6;color:#cbd5e1;width:max-content;max-width:100%;overflow-x:auto;}
      </style></head><body><div class="topbar"><span class="topbar-title">Cheque Details - Decoded</span></div><pre>\${esc(decoded)}</pre></body></html>\`);
    }
    win.document.close();
  }

  function buildRow(no, chk, date, tcode, tDesc, artId, artDesc, taxRate, qty, unitPrice, amt, grouped, chequeDetails) {
    const rowCls = grouped ? 'inv-row grouped-row' : 'inv-row';
    const amtVal = parseFloat(amt);
    const amtC = isNaN(amtVal) || amtVal >= 0 ? 'color:#34d399' : 'color:#f87171';
    const chkDisplay = chequeDetails
      ? \`<a href="#" onclick="openChequeDetails('\${chequeDetails.replace(/'/g, "\\\\'")}');return false;" title="View decoded ChequeDetails" style="color:#38bdf8;text-decoration:underline dotted;cursor:pointer;">\${esc(f(chk))}</a><sup style="margin-left:3px;font-size:8px;color:#38bdf8;opacity:.7;">&#x1F517;</sup>\`
      : esc(f(chk));
    return \`<tr class="\${rowCls}">
      <td style="text-align:center;color:#94a3b8;">\${no}</td>
      <td style="font-family:monospace;color:#cbd5e1;">\${chkDisplay}</td>
      <td style="font-family:monospace;color:#cbd5e1;">\${esc(f(date))}</td>
      <td style="font-family:monospace;color:#60a5fa;font-weight:600;">\${esc(f(tcode))}</td>
      <td style="color:#f8fafc;">\${esc(f(tDesc))}</td>
      <td style="font-family:monospace;color:#c084fc;">\${esc(f(artId))}</td>
      <td style="color:#f8fafc;font-size:11px;">\${esc(f(artDesc))}</td>
      <td style="text-align:right;font-family:monospace;color:#f59e0b;">\${esc(f(taxRate))}</td>
      <td style="text-align:right;font-family:monospace;color:#cbd5e1;">\${fn(qty)}</td>
      <td style="text-align:right;font-family:monospace;color:#cbd5e1;">\${fn(unitPrice)}</td>
      <td style="text-align:right;font-family:monospace;font-weight:700;\${amtC};">\${fn(amt)}</td>
    </tr>\`;
  }

  function swapTbody(htmlFn, countFn, badgeOn) {
    const tbody = document.getElementById('postingsTbody');
    const wrap = tbody.closest('.table-wrap');
    const countEl = document.getElementById('postingCount');
    const badgeEl = document.getElementById('groupedBadge');
    const lockedH = wrap.getBoundingClientRect().height;
    const savedY = window.scrollY;
    wrap.style.height = lockedH + 'px';
    wrap.style.overflow = 'hidden';
    tbody.classList.add('fading');
    countEl.classList.add('updating');
    setTimeout(() => {
      tbody.innerHTML = htmlFn();
      countEl.textContent = countFn();
      badgeEl.classList.toggle('visible', !!badgeOn);
      wrap.style.height = '';
      wrap.style.overflow = '';
      window.scrollTo(0, savedY);
      requestAnimationFrame(() => {
        tbody.classList.remove('fading');
        countEl.classList.remove('updating');
      });
    }, 130);
  }

  function buildUngroupedHtml() {
    if (!INV_POSTINGS.length) return '<tr><td colspan="11" style="text-align:center;padding:32px 0;color:#64748b;font-style:italic;">No postings with HRSAmount found.</td></tr>';
    return INV_POSTINGS.map((p, i) => {
      const tcode = p.TrxCode || '';
      const artId = p.ArticleID ?? p.ArticleId ?? p.ArticleCode ?? '';
      const chk = chequeKey(p);
      const chqDet = INV_CHEQUE_MAP[chk] || null;
      return buildRow(i + 1, chk, p.TrxDate, tcode, INV_TRX_DESC[tcode] || '', artId, INV_ART_DESC[tcode + '|' + String(artId)] || '', p.HRSTaxRate, p.Quantity, upr(p.HRSAmount, p.Quantity), p.HRSAmount, false, chqDet);
    }).join('');
  }

  function renderUngrouped() {
    updateGroupingButtons();
    swapTbody(buildUngroupedHtml, () => INV_POSTINGS.length + ' items', false);
  }

  function renderGroupedPostings() {
    if (groupByPackage && !INV_POSTINGS.some(hasPackageValue)) {
      showToast('No TrxNoAgainstPackage found in this bill. Package grouping is not available.');
      groupByPackage = false;
      updateGroupingButtons();
    }
    if (groupByCheckNumber && !INV_POSTINGS.some(hasCheckNumberValue)) {
      showToast('No CheckNumber found in this bill. CheckNumber grouping is not available.');
      groupByCheckNumber = false;
      updateGroupingButtons();
    }
    if (!groupByPackage && !groupByCheckNumber) { renderUngrouped(); return; }

    const groupMap = new Map();
    const solo = [];
    for (const p of INV_POSTINGS) {
      const keys = [];
      let canGroup = true;
      if (groupByPackage) {
        if (hasPackageValue(p)) keys.push(String(p.TrxNoAgainstPackage).trim(), String(p.HRSTaxRate || ''));
        else canGroup = false;
      }
      if (groupByCheckNumber) {
        const chk = chequeKey(p);
        if (chk) keys.push(String(chk));
        else canGroup = false;
      }
      if (canGroup) {
        const key = keys.join('||');
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(p);
      } else {
        solo.push(p);
      }
    }
    swapTbody(
      () => {
        let html = '';
        let rowNo = 1;
        for (const [, group] of groupMap) {
          const byAmt = [...group].sort((a, b) => num(b.HRSAmount) - num(a.HRSAmount));
          const main = byAmt[0] || group[0];
          const sumAmt = sumAmount(group);
          const groupedQty = 1;
          const chk = groupByCheckNumber ? chequeKey(main) : sameOrMixed(group, chequeKey);
          const taxRate = groupByPackage ? main.HRSTaxRate : sameOrMixed(group, 'HRSTaxRate');
          const desc = groupByPackage ? (INV_PKG_DESC || 'Grouped Package') : 'Grouped CheckNumber';
          const articleDesc = group.length + ' posting' + (group.length !== 1 ? 's' : '');
          const chqDet = chk && chk !== 'Mixed' ? (INV_CHEQUE_MAP[chk] || null) : null;
          html += buildRow(rowNo++, chk, group[0].TrxDate, '', desc, '', articleDesc, taxRate, groupedQty, upr(sumAmt, groupedQty), sumAmt, true, chqDet);
        }
        for (const p of solo) {
          const tcode = p.TrxCode || '';
          const artId = p.ArticleID ?? p.ArticleId ?? p.ArticleCode ?? '';
          const chk = chequeKey(p);
          html += buildRow(rowNo++, chk, p.TrxDate, tcode, INV_TRX_DESC[tcode] || '', artId, INV_ART_DESC[tcode + '|' + String(artId)] || '', p.HRSTaxRate, p.Quantity, upr(p.HRSAmount, p.Quantity), p.HRSAmount, false, INV_CHEQUE_MAP[chk] || null);
        }
        return html || '<tr><td colspan="11" style="text-align:center;padding:32px 0;color:#64748b;font-style:italic;">No postings found.</td></tr>';
      },
      () => {
        const gc = groupMap.size, sc = solo.length;
        return gc + ' group' + (gc !== 1 ? 's' : '') + (sc ? ' + ' + sc + ' item' + (sc !== 1 ? 's' : '') : '');
      },
      true
    );
    document.getElementById('groupedBadge').textContent = getGroupingLabel();
  }

  function setGroupingMode(mode) {
    if (mode === 'package') groupByPackage = !groupByPackage;
    if (mode === 'check') groupByCheckNumber = !groupByCheckNumber;
    updateGroupingButtons();
    if (groupByPackage || groupByCheckNumber) renderGroupedPostings();
    else renderUngrouped();
  }

  function showToast(msg) {
    const existing = document.getElementById('inv-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'inv-toast';
    t.innerHTML = '<span style="color:#fbbf24;flex-shrink:0;">!</span><span>' + esc(msg) + '</span>';
    t.style.cssText = [
      'position:fixed','bottom:28px','left:50%','transform:translateX(-50%) translateY(20px)',
      'display:flex','align-items:center','gap:10px',
      'background:#1c1917','border:1px solid rgba(251,191,36,0.35)',
      'color:#fde68a','font-size:12px','font-family:monospace','font-weight:600',
      'padding:11px 20px','border-radius:10px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
      'z-index:9999','opacity:0',
      'transition:opacity .25s ease, transform .25s ease',
      'white-space:nowrap','pointer-events:none'
    ].join(';');
    document.body.appendChild(t);
    requestAnimationFrame(() => {
      t.style.opacity = '1';
      t.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => t.remove(), 280);
    }, 3500);
  }

  renderUngrouped();
  if (${autoOpenCheques} && INV_ALL_CHEQUES.length > 0) {
    setTimeout(openAllChequeDetails, 50);
  }
</script>
</body>
</html>`);
});

app.get('/invoice-legacy/:billNo', (req, res) => {
    const { billNo } = req.params;
    const autoOpenCheques = req.query.showCheques === 'true';
    const record = invoiceStore.get(billNo.toString());

    if (!record) {
        return res.status(404).send(`<body style="background:#0f172a;color:#f43f5e;font-family:sans-serif;padding:40px;text-align:center;">
            <h3>404 TRANSACTION RECORD NOT CACHED</h3>
            <p style="color:#94a3b8">The Bill Number sequence <b>"${billNo}"</b> was not captured in memory. Stream a new transaction payload via your connector tool to automatically compile this page view.</p>
        </body>`);
    }

    const payload = record.data;
    const toArray = (value) => {
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    };
    const safeJson = (value) => JSON.stringify(value).replace(/<\/script>/gi, '<\\/script>');
    const info = payload.FolioDeliveryInfo || payload.DocumentInfo || payload.FolioInfo?.FolioHeaderInfo || {};
    const sum = payload.FolioSummaryInfo || payload.TotalInfo || payload.FolioInfo?.TotalInfo || {};
    const rawPostingDetails = toArray(payload.FolioPostingDetails || payload.Postings?.Posting || payload.FolioInfo?.Postings);
    const postings = rawPostingDetails
        .filter(p => p && p.HRSAmount != null && p.HRSAmount !== 0 && p.HRSAmount !== '0')
        .sort((a, b) => {
            const na = parseFloat(a.TrxNo) || 0;
            const nb = parseFloat(b.TrxNo) || 0;
            return na - nb;
        });

    const trxInfoArr = toArray(payload.TrxInfo || payload.FolioInfo?.TrxInfo);
    const trxDescMap = { ...INV_TRX_DESC };
    const articleDescMap = { ...INV_ART_DESC };
    let packageDescription = trxDescMap["9999"] || "Package Wrapper";
    for (const t of trxInfoArr) {
        const code = t.Code || t.TrxCode || '';
        if (code) trxDescMap[code] = t.Description || trxDescMap[code] || '';
        if ((t.TrxType || '').toUpperCase() === 'PK' && t.Description) {
            packageDescription = t.Description;
        }
        const arts = t.Articles?.Article;
        for (const a of toArray(arts)) {
            const aId = a.ArticleID ?? a.ArticleId ?? a.ArticleCode ?? '';
            if (code && aId !== '') articleDescMap[`${code}|${String(aId)}`] = a.Description || '';
        }
    }

    // Pre-extract unique cheques for horizontal squeezed drawer view
    const chequesArray = [];
    const chequeMap = {};
    const uniqueChequeCheck = new Set();
    const addCheque = (checkNo, rawDetails, aliases = []) => {
        if (!checkNo || !rawDetails) return;
        const checkKey = String(checkNo);
        if (!uniqueChequeCheck.has(checkKey)) {
            uniqueChequeCheck.add(checkKey);
            chequesArray.push({
                checkNo: checkKey,
                rawDetails: String(rawDetails),
                trxNo: aliases.find(Boolean) || ''
            });
        }
        [checkKey, ...aliases].filter(Boolean).forEach(key => {
            chequeMap[String(key)] = String(rawDetails);
        });
    };

    const posChequeArr = toArray(payload.FolioInfo?.PosChequeInfo || payload.PosChequeInfo);
    posChequeArr.forEach(ci => {
        if (!ci) return;
        const det = Array.isArray(ci.ChequeDetails) ? ci.ChequeDetails[0] : ci.ChequeDetails;
        addCheque(ci.ChequeNo || ci.CheckNo || ci.TrxNo, det, [ci.TrxNo, ci.ChequeNo, ci.CheckNo]);
    });

    rawPostingDetails.forEach(p => {
        if (p?.ChequeDetails && String(p.ChequeDetails).trim() !== "") {
            try {
                const parsed = JSON.parse(p.ChequeDetails);
                const chkNo = parsed.CheckNo || parsed.ChequeNo || p.ChequeNumber || p.TrxNo;
                addCheque(chkNo, p.ChequeDetails, [p.ChequeNumber, p.TrxNo]);
            } catch(e) {
                addCheque(p.ChequeNumber || p.TrxNo, p.ChequeDetails, [p.ChequeNumber, p.TrxNo]);
            }
        }
    });

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HRS Live Draft Viewer - Bill ${billNo}</title>
    <style>
        *, *::before, *::after { box-sizing:border-box; }
        body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#09090b; color:#e4e4e7; margin:0; padding:0 0 40px; font-size:13px; }
        .topbar { height:56px; background:#18181b; border-bottom:1px solid #27272a; display:flex; align-items:center; padding:0 24px; gap:16px; position:sticky; top:0; z-index:20; box-shadow:0 2px 12px rgba(0,0,0,.4); }
        .logo-box { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,#34d399,#0ea5e9); padding:2px; flex-shrink:0; }
        .logo-inner { width:100%; height:100%; background:#09090b; border-radius:8px; display:flex; align-items:center; justify-content:center; }
        .logo-text { background:linear-gradient(135deg,#34d399,#38bdf8); -webkit-background-clip:text; -webkit-text-fill-color:transparent; font-weight:900; font-family:monospace; font-size:11px; }
        .topbar-title { color:#34d399; font-weight:700; letter-spacing:.12em; font-size:13px; text-transform:uppercase; }
        .topbar-sub { font-size:9px; color:#52525b; text-transform:uppercase; letter-spacing:.15em; font-weight:600; font-family:monospace; }
        .topbar-divider { width:1px; height:28px; background:#27272a; margin:0 8px; }
        .topbar-badge { display:flex; align-items:center; gap:8px; background:#27272a; border:1px solid #3f3f46; border-radius:999px; padding:4px 14px; font-family:monospace; font-size:11px; }
        .topbar-badge .dot { width:7px; height:7px; border-radius:50%; background:#34d399; box-shadow:0 0 6px #10b981; }
        .topbar-badge .lbl { color:#71717a; font-weight:700; text-transform:uppercase; letter-spacing:.06em; font-size:9px; }
        .topbar-badge .val { color:#34d399; font-weight:700; }
        .topbar-right { margin-left:auto; display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
        .page { max-width:1280px; margin:0 auto; padding:24px 24px 0; }
        .card { background:#18181b; border:1px solid #27272a; border-radius:12px; padding:20px; margin-bottom:20px; box-shadow:0 10px 28px rgba(0,0,0,0.26); }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:16px 24px; }
        .field { display:flex; flex-direction:column; gap:4px; min-width:0; }
        .label { color:#52525b; font-size:9px; text-transform:uppercase; letter-spacing:.12em; font-weight:700; font-family:monospace; }
        .val { font-size:13px; font-weight:600; color:#e4e4e7; font-family:monospace; overflow-wrap:anywhere; }
        .flex-header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:0; padding:10px 16px; background:#09090b; border:1px solid #27272a; border-bottom:none; border-radius:12px 12px 0 0; }
        .section-title { font-size:10px; font-weight:700; color:#71717a; text-transform:uppercase; letter-spacing:.12em; font-family:monospace; display:flex; align-items:center; gap:8px; margin:0; }
        .section-count { background:#27272a; border:1px solid #3f3f46; color:#a1a1aa; font-family:monospace; font-size:9px; font-weight:700; padding:2px 8px; border-radius:999px; transition:opacity .12s; }
        .section-count.updating { opacity:0; }
        .grouped-badge { display:none; align-items:center; gap:6px; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.25); color:#38bdf8; font-family:monospace; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; padding:2px 10px; border-radius:999px; }
        .grouped-badge.visible { display:flex; }
        .group-toggle { display:flex; align-items:center; gap:8px; background:#27272a; border:1px solid #3f3f46; border-radius:8px; padding:6px 14px; font-size:11px; font-weight:600; cursor:pointer; text-transform:uppercase; letter-spacing:.05em; color:#a1a1aa; transition:background .15s,border-color .15s,color .15s,transform .12s; user-select:none; }
        .group-toggle:hover { background:#3f3f46; color:#e4e4e7; }
        .group-toggle.on { background:rgba(56,189,248,0.12); border-color:rgba(56,189,248,0.4); color:#38bdf8; }
        .group-toggle:active { transform:scale(.98); }
        .group-toggle .toggle-pip { width:26px; height:14px; border-radius:999px; background:#3f3f46; position:relative; transition:background .2s; flex-shrink:0; }
        .group-toggle .toggle-pip::after { content:''; position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%; background:#71717a; transition:transform .2s, background .2s; }
        .group-toggle.on .toggle-pip { background:rgba(56,189,248,0.3); }
        .group-toggle.on .toggle-pip::after { transform:translateX(12px); background:#38bdf8; }
        .cheque-tools { display:flex; align-items:center; gap:8px; min-width:0; margin-bottom:18px; }
        .cheque-badge { display:inline-flex; align-items:center; gap:8px; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.25); color:#34d399; font-family:monospace; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; border-radius:6px; padding:5px 12px; cursor:pointer; transition:all .15s; white-space:nowrap; }
        .cheque-badge:hover { background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.4); }
        .cheque-wrap-container { display:flex; flex-wrap:nowrap; gap:4px; min-width:0; overflow-x:auto; padding:2px 0 4px; scrollbar-width:thin; }
        .cheque-btn { flex:0 0 auto; background:#18181b; border:1px solid #27272a; color:#34d399; font-family:monospace; font-size:10px; font-weight:700; padding:4px 7px; border-radius:6px; cursor:pointer; transition:background .15s,border-color .15s,color .15s,transform .12s; display:inline-flex; align-items:center; gap:4px; max-width:136px; }
        .cheque-btn span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cheque-btn:hover { background:rgba(16,185,129,0.1); border-color:rgba(16,185,129,0.35); transform:translateY(-1px); }
        .table-wrap { background:#18181b; border:1px solid #27272a; border-top:none; border-radius:0 0 12px 12px; overflow-x:auto; margin-bottom:20px; }
        table { width:100%; border-collapse:collapse; text-align:left; font-size:11.5px; }
        th { background:#09090b; color:#52525b; font-weight:700; padding:10px 8px; border-bottom:1px solid #27272a; font-size:9px; text-transform:uppercase; letter-spacing:.08em; font-family:monospace; white-space:nowrap; }
        td { padding:8px; border-bottom:1px solid rgba(39,39,42,0.4); color:#cbd5e1; vertical-align:middle; white-space:nowrap; transition:background .15s; }
        tr:hover td { background:rgba(255,255,255,0.025); }
        .inv-row.grouped-row td { background:rgba(56,189,248,0.05); }
        .inv-row.grouped-row td:first-child { border-left:2px solid rgba(56,189,248,0.4); padding-left:6px; }
        .modal-overlay { position:fixed; inset:0; background:rgba(9,9,11,0.82); backdrop-filter:blur(4px); z-index:9000; display:flex; align-items:center; justify-content:center; opacity:0; pointer-events:none; transition:opacity .2s; }
        .modal-overlay.open { opacity:1; pointer-events:auto; }
        .modal-card { background:#18181b; border:1px solid #27272a; border-radius:12px; max-width:620px; width:calc(100% - 32px); box-shadow:0 25px 50px -12px rgba(0,0,0,0.5); overflow:hidden; transform:scale(.96); transition:transform .2s; }
        .modal-overlay.open .modal-card { transform:scale(1); }
        .modal-header { padding:14px; background:#09090b; border-bottom:1px solid #27272a; display:flex; justify-content:space-between; align-items:center; }
        .modal-body { padding:16px; max-height:520px; overflow:auto; font-family:monospace; background:#09090b; margin:12px; border-radius:8px; border:1px solid #27272a; white-space:pre-wrap; font-size:12px; color:#a1a1aa; line-height:1.5; }
        .tbody-target { transition:opacity .12s ease; }
        .tbody-target.fading { opacity:0; pointer-events:none; }
        @media (max-width: 760px) {
            .topbar { padding:0 14px; gap:10px; }
            .topbar-title { font-size:11px; }
            .topbar-badge { display:none; }
            .page { padding:16px 12px 0; }
            .flex-header { align-items:flex-start; flex-direction:column; }
            .cheque-tools { align-items:flex-start; flex-direction:column; }
            .cheque-wrap-container { width:100%; }
        }
    </style>
</head>
<body>

  <div class="topbar">
    <div class="logo-box"><div class="logo-inner"><span class="logo-text">NNK</span></div></div>
    <div><div class="topbar-title">HRS Live Draft Viewer</div><div class="topbar-sub">Vibecoded by NNK</div></div>
    <div class="topbar-divider"></div>
    <div class="topbar-badge">
      <div class="dot"></div>
      <span class="lbl">Bill</span>
      <span class="val">${info.BillNo || billNo}</span>
    </div>
    <div class="topbar-right">
      <button id="packageGroupToggleBtn" class="group-toggle" onclick="setGroupingMode('package')">
        <div class="toggle-pip"></div>
        <span>Group by Package &amp; Tax Rate</span>
      </button>
      <button id="checkGroupToggleBtn" class="group-toggle" onclick="setGroupingMode('check')">
        <div class="toggle-pip"></div>
        <span>Group by CheckNumber</span>
      </button>
    </div>
  </div>

  <div class="page">

  <div class="card grid">
    <div class="field"><span class="label">Hotel Code</span><span class="val" style="color:#38bdf8;">${info.HotelCode || '—'}</span></div>
    <div class="field"><span class="label">Room Number</span><span class="val">${info.RoomNo || '—'}</span></div>
    <div class="field"><span class="label">Bill Number</span><span class="val" style="color:#f43f5e;font-weight:bold;">${info.BillNo || '—'}</span></div>
    <div class="field"><span class="label">Folio Index</span><span class="val">${info.FolioIndex || '—'}</span></div>
    <div class="field"><span class="label">Source Code</span><span class="val" style="color:#a7f3d0;font-family:monospace;font-size:12px;">${info.Source || '—'}</span></div>
    <div class="field"><span class="label">Command Mode</span><span class="val" style="color:#fbbf24;font-family:monospace;font-size:12px;">${payload.Command || '—'}</span></div>
  </div>

  ${chequesArray.length > 0 ? `
  <div class="card" style="padding:12px; margin-bottom:16px;">
    <div class="cheque-tools" style="margin-bottom:8px;">
      <button class="cheque-badge" onclick="openAllChequeDetails()">VIEW ${chequesArray.length} CHEQUE(S)</button>
    </div>
    <div style="font-size:11px; text-transform:uppercase; color:#64748b; font-weight:700; margin-bottom:6px; letter-spacing:0.5px;">Attached Unique POS Cheques (${chequesArray.length})</div>
    <div class="cheque-wrap-container">
       ${chequesArray.map(c => `
         <button class="cheque-btn" onclick="openChequeModal('${c.checkNo}', \`${encodeURIComponent(c.rawDetails)}\`)">
            <span>🎟️</span> Chk #${c.checkNo}
         </button>
       `).join('')}
    </div>
  </div>
  ` : ''}

  <div class="card">
    <div class="flex-header">
      <div style="display:flex; align-items:center;">
         <h3 class="section-title">📊 Folio Postings Ledger</h3>
         <span id="postingCount" class="section-count">${postings.length} items</span>
         <span class="grouped-badge" id="groupedBadge">Grouped</span>
      </div>
      <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap;">
        <button id="inlinePackageGroupToggleBtn" class="group-toggle" onclick="setGroupingMode('package')">
           <div class="toggle-pip"></div>
           <span>Group by Package &amp; Tax Rate</span>
        </button>
        <button id="inlineCheckGroupToggleBtn" class="group-toggle" onclick="setGroupingMode('check')">
           <div class="toggle-pip"></div>
           <span>Group by CheckNumber</span>
        </button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Line#</th>
            <th>Check No.</th>
            <th>Trx Date</th>
            <th>TrxCode</th>
            <th>Trx Code Description</th>
            <th>Article</th>
            <th>Article Description</th>
            <th style="text-align:right;">Tax Rate</th>
            <th style="text-align:right;">Qty</th>
            <th style="text-align:right;">Unit Price</th>
            <th style="text-align:right;">HRS Amount</th>
          </tr>
        </thead>
        <tbody id="postingTableBody" class="tbody-target">
          </tbody>
      </table>
    </div>
  </div>

  <div class="card grid" style="background:#0f172a; border-color:#232f45;">
     <div class="field"><span class="label">Total Net</span><span class="val">${parseFloat(sum.TotalNet || 0).toLocaleString()}</span></div>
     <div class="field"><span class="label">Gross Revenue</span><span class="val" style="color:#34d399;font-weight:700;">${parseFloat(sum.TotalGross || 0).toLocaleString()}</span></div>
     <div class="field"><span class="label">Rounding</span><span class="val" style="color:#94a3b8;">${parseFloat(sum.TotalRounding || 0).toLocaleString()}</span></div>
     <div class="field"><span class="label">Tip / Gratuity</span><span class="val">${parseFloat(sum.TotalTip || 0).toLocaleString()}</span></div>
  </div>

  </div>

  <div id="chequeModal" class="modal-overlay" onclick="closeChequeModal()">
     <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
           <span id="modalTitle" style="font-weight:700;color:#34d399;">POS Base64 Cheque Viewer</span>
           <span onclick="closeChequeModal()" style="cursor:pointer;color:#64748b;font-weight:bold;font-size:16px;">&times;</span>
        </div>
        <div id="modalBody" class="modal-body">Processing text buffer stream...</div>
     </div>
  </div>

  <script>
    const rawPostings = ${safeJson(postings)};
    const INV_TRX_DESC = ${safeJson(trxDescMap)};
    const INV_ART_DESC = ${safeJson(articleDescMap)};
    const INV_PKG_DESC = ${safeJson(packageDescription)};
    const CHEQUES = ${safeJson(chequesArray)};
    const CHEQUE_MAP = ${safeJson(chequeMap)};
    
    let groupingOn = false;
    let groupByPackage = false;
    let groupByCheckNumber = false;

    // Toast Notification Driver Function
    function showToast(message) {
        const toast = document.getElementById('toast-box');
        document.getElementById('toast-msg').textContent = message;
        toast.classList.add('visible');
        setTimeout(() => { toast.classList.remove('visible'); }, 4000);
    }

    // Interactive Base64 Receipt Unpacker Decoder
    function openChequeModal(title, encData) {
        const dec = decodeURIComponent(encData);
        let innerText = "";
        try {
            const parsed = JSON.parse(dec);
            if (parsed.ReceiptText) {
                // Decode internal Base64 receipt data cleanly
                innerText = atob(parsed.ReceiptText);
            } else {
                innerText = JSON.stringify(parsed, null, 2);
            }
        } catch(e) {
            innerText = "Direct Data String: " + dec;
        }
        document.getElementById('modalTitle').textContent = "Decoded Receipt - Chk #" + title;
        document.getElementById('modalBody').textContent = innerText;
        document.getElementById('chequeModal').classList.add('open');
    }

    function closeChequeModal() {
        document.getElementById('chequeModal').classList.remove('open');
    }

    // Primary Dynamic View Refresh & Calculations Engine
    function renderTable() {
        const tbody = document.getElementById('postingTableBody');
        tbody.classList.add('fading');

        setTimeout(() => {
            let displayedItems = [];

            if (!groupingOn) {
                displayedItems = [...rawPostings];
            } else {
                // Group Package Logic Mirroring original core tool layout
                const packageMap = new Map();
                const separateItems = [];

                rawPostings.forEach(p => {
                    if (p.TrxNoAgainstPackage && p.TrxNoAgainstPackage.trim() !== "") {
                        const parentId = p.TrxNoAgainstPackage.trim();
                        if (!packageMap.has(parentId)) {
                            packageMap.set(parentId, []);
                        }
                        packageMap.get(parentId).push(p);
                    } else {
                        separateItems.push({...p});
                    }
                });

                // Re-incorporate consolidated mappings structures
                packageMap.forEach((childItems, pkgId) => {
                    const matchInSeparateIndex = separateItems.findIndex(i => i.TrxNo === pkgId);
                    if (matchInSeparateIndex !== -1) {
                        let sumAmt = 0;
                        childItems.forEach(c => sumAmt += parseFloat(c.HRSAmount || 0));
                        separateItems[matchInSeparateIndex].HRSAmount = (parseFloat(separateItems[matchInSeparateIndex].HRSAmount || 0) + sumAmt);
                    } else {
                        // Create virtual synthetic parent package header row if real matching parent row was skipped
                        let mockParent = {...childItems[0]};
                        mockParent.TrxNo = pkgId;
                        mockParent.TrxNoAgainstPackage = "";
                        let sumAmt = 0;
                        childItems.forEach(c => sumAmt += parseFloat(c.HRSAmount || 0));
                        mockParent.HRSAmount = sumAmt;
                        separateItems.push(mockParent);
                    }
                });

                displayedItems = separateItems;
            }

            // Sync structural count dynamically across toggle configurations
            document.getElementById('itemsCountBadge').textContent = displayedItems.length + " Items";

            // Map and generate markup
            let html = "";
            const fn = (v) => parseFloat(v || 0).toLocaleString('en-US');
            
            displayedItems.forEach((p, idx) => {
                const up = p.Quantity ? (parseFloat(p.HRSAmount || 0) / parseFloat(p.Quantity)) : p.HRSAmount;
                html += \`
                  <tr>
                    <td style="color:#64748b;font-family:monospace;">\${idx + 1}</td>
                    <td style="font-weight:600;color:#38bdf8;font-family:monospace;">\${p.TrxCode || '—'}</td>
                    <td>\${INV_TRX_DESC[p.TrxCode] || '—'}</td>
                    <td style="font-family:monospace;color:#94a3b8;">\${p.ArticleID || '—'}</td>
                    <td>\${INV_ART_DESC[p.TrxCode + '|' + p.ArticleID] || '—'}</td>
                    <td style="text-align:right;color:#fbbf24;font-family:monospace;">\${p.HRSTaxRate || 0}%</td>
                    <td style="text-align:right;font-family:monospace;">\${p.Quantity || 1}</td>
                    <td style="text-align:right;font-family:monospace;">\${fn(up)}</td>
                    <td style="text-align:right;color:#34d399;font-weight:600;font-family:monospace;">\${fn(p.HRSAmount)}</td>
                  </tr>\`;
            });

            tbody.innerHTML = html || '<tr><td colspan="9" style="text-align:center;color:#6b7280;">No entries discovered inside ledger lines.</td></tr>';
            tbody.classList.remove('fading');
        }, 100);
    }

    // Backward-compatible wrapper for any older inline handler that may still call toggleGrouping.
    function toggleGrouping() {
        setGroupingMode('package');
    }

    // Master-compatible viewer implementation. These definitions intentionally override
    // the earlier draft logic so both grouping controls share the same state.
    function f(v) {
        return (v == null || v === '') ? '--' : String(v);
    }

    function fn(v) {
        const n = parseFloat(v);
        if (Number.isNaN(n)) return '--';
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function jsArg(s) {
        return encodeURIComponent(String(s)).replace(/'/g, '%27');
    }

    function num(v) {
        const n = parseFloat(v);
        return Number.isNaN(n) ? 0 : n;
    }

    function upr(amt, qty) {
        const q = num(qty);
        if (!q) return null;
        return num(amt) / q;
    }

    function sumAmount(rows) {
        return rows.reduce((s, p) => s + num(p.HRSAmount), 0);
    }

    function sameOrMixed(rows, fieldOrGetter) {
        const getVal = typeof fieldOrGetter === 'function' ? fieldOrGetter : (p) => p[fieldOrGetter];
        const vals = [...new Set(rows.map(getVal).filter((v) => v != null && v !== '').map(String))];
        return vals.length <= 1 ? (vals[0] || '') : 'Mixed';
    }

    function hasPackageValue(p) {
        const v = p && p.TrxNoAgainstPackage;
        if (v == null) return false;
        const s = String(v).trim();
        return s !== '' && s !== '0';
    }

    function chequeKey(p) {
        return p.ChequeNumber || p.CheckNo || p.ChequeNo || p.TrxNo || '';
    }

    function hasCheckNumberValue(p) {
        const v = chequeKey(p || {});
        return v != null && String(v).trim() !== '';
    }

    function updateGroupingButtons() {
        ['packageGroupToggleBtn', 'inlinePackageGroupToggleBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('on', groupByPackage);
        });
        ['checkGroupToggleBtn', 'inlineCheckGroupToggleBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('on', groupByCheckNumber);
        });
    }

    function getGroupingLabel() {
        if (groupByPackage && groupByCheckNumber) return 'Grouped by Package + Tax Rate + CheckNumber';
        if (groupByPackage) return 'Grouped by Package + Tax Rate';
        if (groupByCheckNumber) return 'Grouped by CheckNumber';
        return 'Grouped';
    }

    function base64ToText(b64) {
        try {
            return decodeURIComponent(escape(atob(b64)));
        } catch (e) {
            try { return atob(b64); } catch (err) { return ''; }
        }
    }

    function decodeChequePayload(raw) {
        const data = String(raw || '');
        if (!data) return '';
        try {
            const parsed = JSON.parse(data);
            if (parsed.ReceiptText) return base64ToText(parsed.ReceiptText);
            if (parsed.ChequeDetails) return base64ToText(Array.isArray(parsed.ChequeDetails) ? parsed.ChequeDetails[0] : parsed.ChequeDetails);
            return JSON.stringify(parsed, null, 2);
        } catch (e) {
            const decoded = base64ToText(data);
            return decoded || data;
        }
    }

    function openChequeModalByIndex(index) {
        const item = CHEQUES[index];
        if (!item) return;
        openChequeModal(item.checkNo, encodeURIComponent(item.rawDetails || ''));
    }

    function openChequeModal(title, encData) {
        const dec = decodeURIComponent(encData || '');
        document.getElementById('modalTitle').textContent = 'Decoded Receipt - Chk #' + title;
        document.getElementById('modalBody').textContent = decodeChequePayload(dec) || 'No cheque details available.';
        document.getElementById('chequeModal').classList.add('open');
    }

    function openChequeModalFromRow(encTitle, encData) {
        openChequeModal(decodeURIComponent(encTitle || ''), encData);
    }

    function openAllChequeDetails() {
        if (!CHEQUES.length) return;
        const win = window.open('', '_blank');
        if (!win) {
            showToast('Pop-up blocked. Please allow pop-ups to view cheque details.');
            return;
        }
        win.document.open();
        win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>All Cheque Details</title><style>');
        win.document.write('*{box-sizing:border-box;margin:0;padding:0;}body{background:#09090b;color:#e4e4e7;font-family:monospace;font-size:12px;padding:24px;}');
        win.document.write('.topbar{height:48px;background:#18181b;border-bottom:1px solid #27272a;display:flex;align-items:center;padding:0 20px;gap:12px;margin:-24px -24px 24px;font-size:11px;position:sticky;top:0;z-index:10;}');
        win.document.write('.topbar-title{color:#34d399;font-weight:700;letter-spacing:.1em;text-transform:uppercase;}');
        win.document.write('.cheque-container{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;}');
        win.document.write('.cheque-box{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:16px;line-height:1.5;color:#a1a1aa;white-space:pre;word-break:break-all;width:max-content;max-width:100%;overflow-x:auto;}');
        win.document.write('.cheque-head{color:#34d399;font-weight:bold;margin-bottom:12px;display:block;border-bottom:1px dashed #27272a;padding-bottom:8px;}');
        win.document.write('</style></head><body><div class="topbar"><span class="topbar-title">All Cheque Details - ' + CHEQUES.length + ' Receipt(s)</span></div><div class="cheque-container">');
        CHEQUES.forEach(item => {
            const safeNo = esc(item.checkNo || 'POS');
            const safeText = esc(decodeChequePayload(item.rawDetails || '') || 'No cheque details available.');
            win.document.write('<div class="cheque-box"><span class="cheque-head">--- CHEQUE NO: ' + safeNo + ' ---</span>\\n' + safeText + '</div>');
        });
        win.document.write('</div></body></html>');
        win.document.close();
    }

    function closeChequeModal() {
        document.getElementById('chequeModal').classList.remove('open');
    }

    function showToast(msg) {
        const existing = document.getElementById('inv-toast');
        if (existing) existing.remove();
        const t = document.createElement('div');
        t.id = 'inv-toast';
        t.innerHTML = '<span style="color:#fbbf24;flex-shrink:0;">!</span><span>' + esc(msg) + '</span>';
        t.style.cssText = [
            'position:fixed','bottom:28px','left:50%','transform:translateX(-50%) translateY(20px)',
            'display:flex','align-items:center','gap:10px',
            'background:#1c1917','border:1px solid rgba(251,191,36,0.35)',
            'color:#fde68a','font-size:12px','font-family:monospace','font-weight:600',
            'padding:11px 20px','border-radius:10px',
            'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
            'z-index:9999','opacity:0',
            'transition:opacity .25s ease, transform .25s ease',
            'white-space:nowrap','pointer-events:none'
        ].join(';');
        document.body.appendChild(t);
        requestAnimationFrame(() => {
            t.style.opacity = '1';
            t.style.transform = 'translateX(-50%) translateY(0)';
        });
        setTimeout(() => {
            t.style.opacity = '0';
            t.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => t.remove(), 280);
        }, 3500);
    }

    function chequeDetailsFor(checkNo) {
        if (checkNo == null) return null;
        return CHEQUE_MAP[String(checkNo)] || null;
    }

    function buildRow(no, chk, date, tcode, tDesc, artId, artDesc, taxRate, qty, unitPrice, amt, grouped, chequeDetails) {
        const rowCls = grouped ? 'inv-row grouped-row' : 'inv-row';
        const amtVal = parseFloat(amt);
        const amtC = Number.isNaN(amtVal) || amtVal >= 0 ? 'color:#34d399' : 'color:#f87171';
        const chkText = esc(f(chk));
        const encodedCheque = chequeDetails ? encodeURIComponent(chequeDetails).replace(/'/g, '%27') : '';
        const chkDisplay = chequeDetails
            ? '<a href="#" onclick="openChequeModalFromRow(\\'' + jsArg(f(chk)) + '\\', \\'' + encodedCheque + '\\');return false;" title="View decoded ChequeDetails" style="color:#38bdf8;text-decoration:underline dotted;cursor:pointer;">' + chkText + '</a><sup style="margin-left:3px;font-size:8px;color:#38bdf8;opacity:.7;">link</sup>'
            : chkText;
        return '<tr class="' + rowCls + '">' +
            '<td style="text-align:center;color:#71717a;">' + no + '</td>' +
            '<td style="font-family:monospace;color:#a1a1aa;">' + chkDisplay + '</td>' +
            '<td style="font-family:monospace;color:#a1a1aa;">' + esc(f(date)) + '</td>' +
            '<td style="font-family:monospace;color:#60a5fa;font-weight:600;">' + esc(f(tcode)) + '</td>' +
            '<td style="color:#e4e4e7;">' + esc(f(tDesc)) + '</td>' +
            '<td style="font-family:monospace;color:#c084fc;">' + esc(f(artId)) + '</td>' +
            '<td style="color:#e4e4e7;font-size:11px;">' + esc(f(artDesc)) + '</td>' +
            '<td style="text-align:right;font-family:monospace;color:#f59e0b;">' + esc(f(taxRate)) + '</td>' +
            '<td style="text-align:right;font-family:monospace;color:#a1a1aa;">' + fn(qty) + '</td>' +
            '<td style="text-align:right;font-family:monospace;color:#a1a1aa;">' + fn(unitPrice) + '</td>' +
            '<td style="text-align:right;font-family:monospace;font-weight:700;' + amtC + ';">' + fn(amt) + '</td>' +
        '</tr>';
    }

    function swapTbody(htmlFn, countFn, badgeOn) {
        const tbody = document.getElementById('postingTableBody');
        const wrap = tbody.closest('.table-wrap') || tbody.parentElement;
        const countEl = document.getElementById('postingCount');
        const badgeEl = document.getElementById('groupedBadge');
        const lockedH = wrap.getBoundingClientRect().height;
        const savedY = window.scrollY;

        wrap.style.height = lockedH + 'px';
        wrap.style.overflow = 'hidden';
        tbody.classList.add('fading');
        if (countEl) countEl.classList.add('updating');

        setTimeout(() => {
            tbody.innerHTML = htmlFn();
            if (countEl) countEl.textContent = countFn();
            if (badgeEl) badgeEl.classList.toggle('visible', !!badgeOn);
            wrap.style.height = '';
            wrap.style.overflow = '';
            window.scrollTo(0, savedY);
            requestAnimationFrame(() => {
                tbody.classList.remove('fading');
                if (countEl) countEl.classList.remove('updating');
            });
        }, 130);
    }

    function buildUngroupedHtml() {
        if (!rawPostings.length) {
            return '<tr><td colspan="11" style="text-align:center;padding:32px 0;color:#52525b;font-style:italic;">No postings with HRSAmount found.</td></tr>';
        }
        return rawPostings.map((p, i) => {
            const tcode = p.TrxCode || '';
            const artId = p.ArticleID ?? p.ArticleId ?? p.ArticleCode ?? '';
            const chq = chequeKey(p);
            const chqDet = chequeDetailsFor(chq);
            return buildRow(i + 1, chq, p.TrxDate, tcode,
                INV_TRX_DESC[tcode] || '', artId,
                INV_ART_DESC[tcode + '|' + String(artId)] || '',
                p.HRSTaxRate, p.Quantity, upr(p.HRSAmount, p.Quantity), p.HRSAmount, false, chqDet);
        }).join('');
    }

    function renderUngrouped() {
        updateGroupingButtons();
        swapTbody(
            buildUngroupedHtml,
            () => rawPostings.length + ' items',
            false
        );
    }

    function renderGroupedPostings() {
        if (groupByPackage && !rawPostings.some(hasPackageValue)) {
            showToast('No TrxNoAgainstPackage found in this bill. Package grouping is not available.');
            groupByPackage = false;
            updateGroupingButtons();
        }
        if (groupByCheckNumber && !rawPostings.some(hasCheckNumberValue)) {
            showToast('No CheckNumber found in this bill. CheckNumber grouping is not available.');
            groupByCheckNumber = false;
            updateGroupingButtons();
        }
        if (!groupByPackage && !groupByCheckNumber) { renderUngrouped(); return; }

        const groupMap = new Map();
        const solo = [];
        for (const p of rawPostings) {
            const keys = [];
            let canGroup = true;
            if (groupByPackage) {
                if (hasPackageValue(p)) keys.push(String(p.TrxNoAgainstPackage).trim(), String(p.HRSTaxRate || ''));
                else canGroup = false;
            }
            if (groupByCheckNumber) {
                const chk = chequeKey(p);
                if (chk) keys.push(String(chk));
                else canGroup = false;
            }
            if (canGroup) {
                const key = keys.join('||');
                if (!groupMap.has(key)) groupMap.set(key, []);
                groupMap.get(key).push(p);
            } else {
                solo.push(p);
            }
        }

        swapTbody(
            () => {
                let html = '';
                let rowNo = 1;
                for (const [, group] of groupMap) {
                    const byAmt = [...group].sort((a, b) => num(b.HRSAmount) - num(a.HRSAmount));
                    const main = byAmt[0] || group[0];
                    const sumAmt = sumAmount(group);
                    const groupedQty = 1;
                    const chk = groupByCheckNumber ? chequeKey(main) : sameOrMixed(group, chequeKey);
                    const taxRate = groupByPackage ? main.HRSTaxRate : sameOrMixed(group, 'HRSTaxRate');
                    const desc = groupByPackage ? (INV_PKG_DESC || 'Grouped Package') : 'Grouped CheckNumber';
                    const articleDesc = group.length + ' posting' + (group.length !== 1 ? 's' : '');
                    const pkgChqDet = chk && chk !== 'Mixed' ? chequeDetailsFor(chk) : null;
                    html += buildRow(rowNo++, chk, group[0].TrxDate,
                        '', desc, '', articleDesc, taxRate, groupedQty, upr(sumAmt, groupedQty), sumAmt, true, pkgChqDet);
                }
                for (const p of solo) {
                    const tcode = p.TrxCode || '';
                    const artId = p.ArticleID ?? p.ArticleId ?? p.ArticleCode ?? '';
                    const chk = chequeKey(p);
                    const soloChqDet = chequeDetailsFor(chk);
                    html += buildRow(rowNo++, chk, p.TrxDate, tcode,
                        INV_TRX_DESC[tcode] || '', artId,
                        INV_ART_DESC[tcode + '|' + String(artId)] || '',
                        p.HRSTaxRate, p.Quantity, upr(p.HRSAmount, p.Quantity), p.HRSAmount, false, soloChqDet);
                }
                return html || '<tr><td colspan="11" style="text-align:center;padding:32px 0;color:#52525b;font-style:italic;">No postings found.</td></tr>';
            },
            () => {
                const gc = groupMap.size;
                const sc = solo.length;
                return gc + ' group' + (gc !== 1 ? 's' : '') + (sc ? ' + ' + sc + ' item' + (sc !== 1 ? 's' : '') : '');
            },
            true
        );
        const badgeEl = document.getElementById('groupedBadge');
        if (badgeEl) badgeEl.textContent = getGroupingLabel();
    }

    function renderTable() {
        if (groupByPackage || groupByCheckNumber) renderGroupedPostings();
        else renderUngrouped();
    }

    function setGroupingMode(mode) {
        if (mode === 'package') groupByPackage = !groupByPackage;
        if (mode === 'check') groupByCheckNumber = !groupByCheckNumber;
        groupingOn = groupByPackage || groupByCheckNumber;
        updateGroupingButtons();
        if (groupingOn) renderGroupedPostings();
        else renderUngrouped();
    }

    // Self-starting execution wrapper bootstrapper loop
    window.addEventListener('DOMContentLoaded', () => {
        renderTable();
        // If query flags explicitly called out cheque viewer execution path initialization
        if (${autoOpenCheques} && ${chequesArray.length > 0}) {
             openChequeModal('${chequesArray[0]?.checkNo || "POS"}', \`${encodeURIComponent(chequesArray[0]?.rawDetails || "")}\`);
        }
    });
  </script>
</body>
</html>`);
});

// Fire up the node service context
const server = app.listen(PORT, () => {
    console.log(`\n\x1b[32m✔ Service running successfully on separate port!\x1b[0m`);
    console.log(`-----------------------------------------------------------------`);
    console.log(`• Live Monitor Dashboard :  \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`-----------------------------------------------------------------\n`);
});

server.on('error', error => {
    console.error(`[\x1b[31mSERVER ERROR\x1b[0m] ${error.message}`);
});
