const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.set('trust proxy', true);

const PORT = Number(process.env.PORT) || 9090;
const SETTINGS_FILE = path.join(__dirname, 'app-settings.json');
const SESSION_COOKIE = 'hrs_admin_session';
const ADMIN = {
  username: process.env.HRS_ADMIN_USER || 'hrsadmin',
  password: process.env.HRS_ADMIN_PASSWORD || '',
  displayName: process.env.HRS_ADMIN_DISPLAY_NAME || 'Administrator'
};
const DEFAULTS = {
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
  const c = raw?.controls || {};
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
  return { StatusCode: 401, IsError: true, Message: 'Unauthorized request.', Result: 'Error! Please check message 401!', ErrorCode: 401 };
}
function serverPayload() {
  return { StatusCode: 500, IsError: true, Message: 'Einvoice Server Error! Contact Einvoice Admin!', Result: 'Einvoice Server Error! Contact Einvoice Admin!', ErrorCode: 500 };
}

const billNo = (d) => first(d?.FolioDeliveryInfo?.BillNo, d?.DocumentInfo?.BillNo, d?.FolioInfo?.FolioHeaderInfo?.BillNo);
const hotelCode = (d) => first(d?.HotelInfo?.HotelCode, d?.FolioDeliveryInfo?.HotelCode, d?.DocumentInfo?.HotelCode);
function reservationInfo(d) {
  return d?.ReservationInfo || d?.FolioInfo?.ReservationInfo || {};
}
const roomNo = (d) => first(d?.FolioDeliveryInfo?.RoomNo, d?.FolioDeliveryInfo?.RoomNumber, reservationInfo(d)?.RoomNumber);
const summary = (d) => {
  const s = d?.FolioSummaryInfo || d?.TotalInfo || d?.FolioInfo?.TotalInfo || {};
  return {
    TotalNet: num(s.TotalNet, s.NetAmount),
    TotalGross: num(s.TotalGross, s.GrossAmount),
    TotalSvc8: num(s.TotalSvc8, s.TotalSVC8),
    TotalSvc10: num(s.TotalSvc10, s.TotalSVC10),
    TotalVat8: num(s.TotalVat8, s.TotalVAT8),
    TotalVat10: num(s.TotalVat10, s.TotalVAT10),
    TotalVat5: num(s.TotalVat5, s.TotalVAT5),
    TotalSct30: num(s.TotalSct30, s.TotalSCT30),
    TotalSct20: num(s.TotalSct20, s.TotalSCT20),
    TotalPaidOut: num(s.TotalPaidOut, s.PaidOut),
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
function formatDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}
function validPostings(d) {
  return postings(d)
    .filter(p => p && p.HRSAmount != null && p.HRSAmount !== 0 && p.HRSAmount !== '0')
    .sort((a, b) => num(a?.TrxNo) - num(b?.TrxNo));
