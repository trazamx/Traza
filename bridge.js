// TRAZA - SphereGT Bridge
// Railway-ready: single PORT, serves app + API together

require(‘dotenv’).config();
const express   = require(‘express’);
const cors      = require(‘cors’);
const puppeteer = require(‘puppeteer’);
const path      = require(‘path’);
const fs        = require(‘fs’);
const Stripe    = require(‘stripe’);

const PORT = process.env.PORT || 4000;
const app  = express();

app.use(cors());
app.use(express.json());

let browser      = null;
let page         = null;
let vehicles     = [];
let lastSync     = null;
let syncStatus   = ‘idle’;
let syncError    = null;

const SPHEREGT_URL  = process.env.SPHEREGT_URL  || ‘https://monitor.spheregt.com/login.html’;
const SPHEREGT_USER = process.env.SPHEREGT_USER || ‘’;
const SPHEREGT_PASS = process.env.SPHEREGT_PASS || ‘’;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || ‘15000’);
const SESSION_PATH  = ‘/tmp/spheregt-session’;

app.get(’/app’, (req, res) => {
const file = path.join(__dirname, ‘delivery_platform_v2.html’);
if (!fs.existsSync(file)) return res.status(404).send(‘delivery_platform_v2.html not found’);
let html = fs.readFileSync(file, ‘utf8’);
const proto = req.headers[‘x-forwarded-proto’] || ‘https’;
const host  = req.headers[‘x-forwarded-host’]  || req.headers.host;
html = html.replace(
/const BRIDGE_URL\s*=\s*[’”][^’”]*[’”]/,
`const BRIDGE_URL = '${proto}://${host}'`
);
res.setHeader(‘Content-Type’, ‘text/html’);
res.send(html);
});

app.get(’/’, (req, res) => res.redirect(’/app’));

app.get(’/vehicles’, (req, res) => {
res.json({ ok: true, count: vehicles.length, lastSync, status: syncStatus, vehicles });
});

app.get(’/vehicles/:id’, (req, res) => {
const v = vehicles.find(v => v.id === req.params.id);
if (!v) return res.status(404).json({ ok: false, error: ‘Not found’ });
res.json({ ok: true, vehicle: v });
});

app.get(’/status’, (req, res) => {
res.json({
ok: syncStatus !== ‘error’,
syncStatus, syncError, lastSync,
vehicleCount: vehicles.length,
pollInterval: POLL_INTERVAL,
user: SPHEREGT_USER ? SPHEREGT_USER.substring(0,3) + ‘***’ : ‘NOT SET’,
env: process.env.RAILWAY_ENVIRONMENT || ‘local’,
});
});

app.post(’/refresh’, async (req, res) => {
await pollVehicles();
res.json({ ok: true, vehicleCount: vehicles.length, lastSync });
});

app.post(’/create-payment-intent’, async (req, res) => {
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
return res.status(500).json({ ok: false, error: ‘STRIPE_SECRET_KEY no configurada en Railway Variables’ });
}
const stripe = Stripe(STRIPE_SECRET_KEY);
const { amount } = req.body;
if (!amount || isNaN(amount)) {
return res.status(400).json({ ok: false, error: ‘Monto invalido’ });
}
try {
const intent = await stripe.paymentIntents.create({
amount: Math.round(amount),
currency: ‘mxn’,
payment_method_types: [‘card’],
});
res.json({ ok: true, clientSecret: intent.client_secret });
} catch(e) {
console.error(‘Stripe error:’, e.message);
res.status(400).json({ ok: false, error: e.message });
}
});

app.post(’/chat’, async (req, res) => {
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
return res.status(500).json({ ok: false, error: ‘ANTHROPIC_API_KEY not set’ });
}
const { message, history } = req.body;
if (!message) return res.status(400).json({ ok: false, error: ‘No message provided’ });
const messages = [];
if (Array.isArray(history)) {
history.slice(-6).forEach(m => {
if (m.role && m.content) messages.push({ role: m.role, content: m.content });
});
}
messages.push({ role: ‘user’, content: message });
try {
const https = require(‘https’);
const payload = JSON.stringify({
model: ‘claude-haiku-4-5-20251001’,
max_tokens: 400,
system: ‘Eres el asistente virtual de TRAZA Logistica Inteligente, empresa de entregas en Monterrey, Mexico. Responde siempre en espanol de manera concisa y amable. Servicios: Express $149 menos de 2hrs, Same-Day $99 mismo dia, Programado $199. Contacto: trazalogisticamx@gmail.com | 811 555 0619. Respuestas maximo 3-4 oraciones.’,
messages,
});
const options = {
hostname: ‘api.anthropic.com’,
path: ‘/v1/messages’,
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘x-api-key’: ANTHROPIC_KEY,
‘anthropic-version’: ‘2023-06-01’,
‘Content-Length’: Buffer.byteLength(payload),
},
};
const apiReq = https.request(options, apiRes => {
let data = ‘’;
apiRes.on(‘data’, chunk => data += chunk);
apiRes.on(‘end’, () => {
try {
const parsed = JSON.parse(data);
if (parsed.error) return res.status(500).json({ ok: false, error: parsed.error.message || ‘API error’ });
const text = parsed.content?.[0]?.text;
if (!text) return res.status(500).json({ ok: false, error: ‘Respuesta vacia’ });
res.json({ ok: true, reply: text });
} catch(e) {
res.status(500).json({ ok: false, error: ’Parse error: ’ + e.message });
}
});
});
apiReq.on(‘error’, e => res.status(500).json({ ok: false, error: e.message }));
apiReq.write(payload);
apiReq.end();
} catch(e) {
res.status(500).json({ ok: false, error: e.message });
}
});

app.get(’/dashboard’, (req, res) => {
res.send(’<!DOCTYPE html><html><head><title>TRAZA Bridge</title><meta charset="UTF-8"><style>body{font-family:monospace;background:#0a0a0f;color:#f2f2f8;padding:24px}h1{color:#2d7eff}a{color:#2d7eff;margin-right:18px}button{background:#2d7eff;color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;margin-top:14px}</style></head><body><h1>TRAZA Bridge</h1><p id="s">Loading…</p><div><a href="/app">App</a><a href="/vehicles">Vehicles</a><a href="/status">Status</a></div><button onclick="force()">Force Sync</button><script>async function load(){const d=await fetch(”/status”).then(r=>r.json()).catch(()=>({}));document.getElementById(“s”).textContent=“Status: “+d.syncStatus+” | Vehicles: “+(d.vehicleCount||0)+” | Last: “+(d.lastSync?new Date(d.lastSync).toLocaleTimeString():“Never”);}async function force(){await fetch(”/refresh”,{method:“POST”});load();}load();setInterval(load,5000);</script></body></html>’);
});

async function launchBrowser() {
console.log(‘Launching browser…’);
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
browser = await puppeteer.launch({
headless: ‘new’,
userDataDir: SESSION_PATH,
executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
args: [’–no-sandbox’,’–disable-setuid-sandbox’,’–disable-dev-shm-usage’,’–disable-gpu’,’–no-zygote’,’–single-process’],
});
page = await browser.newPage();
await page.setRequestInterception(true);
page.on(‘request’, req => {
if ([‘image’,‘font’,‘media’,‘stylesheet’].includes(req.resourceType())) req.abort();
else req.continue();
});
page.on(‘response’, async response => {
const url = response.url();
const ct  = response.headers()[‘content-type’] || ‘’;
if (ct.includes(‘json’) || ct.includes(‘text/plain’)) {
try {
const text = await response.text().catch(() => null);
if (text && text.length > 10 && text.length < 50000) {
const body = JSON.parse(text);
if (body) parseVehicleResponse(url, body);
}
} catch (_) {}
}
});
console.log(‘Browser ready’);
}

async function login() {
console.log(‘Logging into SphereGT…’);
syncStatus = ‘syncing’;
try {
await page.goto(SPHEREGT_URL, { waitUntil: ‘domcontentloaded’, timeout: 40000 });
await new Promise(r => setTimeout(r, 3000));
const filled = await page.evaluate((user, pass) => {
const userInput = document.getElementById(‘txtUser’) || document.querySelector(‘input[name=“txtUser”]’);
const passInput = document.getElementById(‘txtClave’) || document.querySelector(‘input[name=“txtClave”]’);
if (!userInput || !passInput) return { ok: false, reason: ‘fields not found’ };
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, ‘value’).set;
setter.call(userInput, user);
userInput.dispatchEvent(new Event(‘input’, { bubbles: true }));
userInput.dispatchEvent(new Event(‘change’, { bubbles: true }));
setter.call(passInput, pass);
passInput.dispatchEvent(new Event(‘input’, { bubbles: true }));
passInput.dispatchEvent(new Event(‘change’, { bubbles: true }));
return { ok: true };
}, SPHEREGT_USER, SPHEREGT_PASS);
if (!filled.ok) throw new Error(’Could not fill login fields: ’ + filled.reason);
await new Promise(r => setTimeout(r, 500));
await page.evaluate(() => {
const btn = document.querySelector(‘button[type=“submit”],input[type=“submit”],.btn-primary,button’);
if (btn) btn.click();
else { const form = document.querySelector(‘form’); if (form) form.submit(); }
});
await page.waitForNavigation({ waitUntil: ‘networkidle2’, timeout: 25000 }).catch(() => {});
if (page.url().includes(‘login’)) throw new Error(‘Still on login page - check credentials’);
console.log(‘Logged in’);
return true;
} catch (err) {
syncStatus = ‘error’; syncError = err.message;
console.error(‘Login failed:’, err.message);
return false;
}
}

let unitMap = {};

function parseVehicleResponse(url, body) {
try {
const list = (body && body.Datos) ? body.Datos
: Array.isArray(body) ? body
: (body && (body.data || body.units || body.vehicles)) ? (body.data || body.units || body.vehicles)
: null;
if (!list || !Array.isArray(list) || list.length === 0) return;
if (url.includes(‘ObtenerUnidades’)) {
list.forEach(u => {
if (u.IdUnidad) unitMap[u.IdUnidad] = { name: u.NombreUnidad || u.Nombre || (‘Unit ‘+u.IdUnidad), plate: u.Placas||u.Placa||’’, eco: u.NumeroEconomico||’’ };
});
return;
}
if (url.includes(‘ObtenerPosicion’)) {
const parsed = list.map(p => {
const lat = parseFloat(p.Latitud ?? p.lat ?? null);
const lng = parseFloat(p.Longitud ?? p.lng ?? null);
if (isNaN(lat) || isNaN(lng)) return null;
const info = unitMap[p.IdUnidad] || {};
return { id: String(p.IdUnidad), name: info.name||(‘Unit ‘+p.IdUnidad), plate: info.plate||’’, eco: info.eco||’’, lat, lng, speed: parseFloat(p.Velocidad??0)||0, heading: parseFloat(p.Angulo??0)||0, status: (p.Velocidad>2)?‘moving’:‘stopped’, location: p.Ubicacion||’’, updated: p.Fecha||new Date().toISOString() };
}).filter(Boolean);
if (parsed.length > 0) { vehicles = parsed; lastSync = new Date().toISOString(); syncStatus = ‘ok’; syncError = null; console.log(’GPS synced: ’+parsed.length); }
return;
}
const parsed = list.map(normalizeVehicle).filter(Boolean);
if (parsed.length > 0) { vehicles = parsed; lastSync = new Date().toISOString(); syncStatus = ‘ok’; syncError = null; }
} catch(e) { console.error(‘parseVehicleResponse error:’, e.message); }
}

function normalizeVehicle(v) {
if (!v || typeof v !== ‘object’) return null;
const lat = parseFloat(v.lat ?? v.latitude ?? v.lt ?? v.y ?? null);
const lng = parseFloat(v.lng ?? v.longitude ?? v.lon ?? v.lo ?? v.x ?? null);
if (isNaN(lat) || isNaN(lng)) return null;
return { id: String(v.id ?? Math.random()), name: String(v.name ?? v.label ?? v.plate ?? ‘Vehicle’), lat, lng, speed: parseFloat(v.speed??0)||0, heading: parseFloat(v.course??v.heading??0)||0, status: String(v.status??‘unknown’), updated: v.updated_at ?? new Date().toISOString() };
}

async function pollVehicles() {
if (!page || !browser) return;
syncStatus = ‘syncing’;
try {
await page.evaluate(() => {
if (typeof refreshUnits === ‘function’) refreshUnits();
if (typeof updateMap    === ‘function’) updateMap();
if (typeof loadVehicles === ‘function’) loadVehicles();
if (typeof getPositions === ‘function’) getPositions();
}).catch(() => {});
const domVehicles = await page.evaluate(() => {
const globals = [window.units, window.vehicles, window.markers, window.devices, window.fleet, window.positions];
for (const g of globals) {
if (Array.isArray(g) && g.length > 0) return g;
if (g && typeof g === ‘object’) { const vals = Object.values(g); if (vals.length > 0 && vals[0]?.lat) return vals; }
}
return null;
}).catch(() => null);
if (domVehicles?.length > 0) {
const parsed = domVehicles.map(normalizeVehicle).filter(Boolean);
if (parsed.length > 0) { vehicles = parsed; lastSync = new Date().toISOString(); syncStatus = ‘ok’; syncError = null; }
} else {
if (!page.url().includes(‘login’)) {
await page.reload({ waitUntil: ‘networkidle2’, timeout: 15000 }).catch(() => {});
} else {
await login();
}
}
if (syncStatus === ‘syncing’) syncStatus = vehicles.length > 0 ? ‘ok’ : ‘waiting’;
} catch (err) {
syncStatus = ‘error’; syncError = err.message;
console.error(‘Poll error:’, err.message);
}
}

async function start() {
app.listen(PORT, ‘0.0.0.0’, () => {
console.log(‘TRAZA running on port ’ + PORT);
console.log(’   App:       /app’);
console.log(’   Dashboard: /dashboard’);
console.log(’   API:       /vehicles’);
console.log(’   Stripe:    /create-payment-intent’);
});
if (!SPHEREGT_USER || !SPHEREGT_PASS) {
console.warn(‘WARNING: SPHEREGT_USER / SPHEREGT_PASS not set. GPS bridge disabled.’);
syncStatus = ‘waiting’;
return;
}
await launchBrowser();
const ok = await login();
if (ok) {
await pollVehicles();
setInterval(pollVehicles, POLL_INTERVAL);
console.log(’Polling every ’ + (POLL_INTERVAL / 1000) + ‘s’);
}
}

process.on(‘SIGINT’,  async () => { if (browser) await browser.close(); process.exit(); });
process.on(‘SIGTERM’, async () => { if (browser) await browser.close(); process.exit(); });

start().catch(console.error);
