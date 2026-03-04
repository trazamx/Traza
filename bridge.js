// ╔══════════════════════════════════════════════════════════╗
//   TRAZA — SphereGT Bridge                               
//   Railway-ready: single PORT, serves app + API together   
// ╚══════════════════════════════════════════════════════════╝

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

// Railway injects PORT automatically — must use it
const PORT = process.env.PORT || 4000;
const app  = express();

app.use(cors());
app.use(express.json());

// ─── State ────────────────────────────────────────────────
let browser      = null;
let page         = null;
let vehicles     = [];
let lastSync     = null;
let syncStatus   = 'idle';
let syncError    = null;

// ─── Config ───────────────────────────────────────────────
const SPHEREGT_URL  = process.env.SPHEREGT_URL  || 'https://monitor.spheregt.com/login.html';
const SPHEREGT_USER = process.env.SPHEREGT_USER || '';
const SPHEREGT_PASS = process.env.SPHEREGT_PASS || '';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000');
const SESSION_PATH  = '/tmp/spheregt-session';

// ─── Serve TRAZA app — patches BRIDGE_URL automatically ─
app.get('/app', (req, res) => {
  const file = path.join(__dirname, 'delivery_platform_v2.html');
  if (!fs.existsSync(file)) return res.status(404).send('delivery_platform_v2.html not found');
  let html = fs.readFileSync(file, 'utf8');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  html = html.replace(
    /const BRIDGE_URL\s*=\s*['"][^'"]*['"]/,
    `const BRIDGE_URL = '${proto}://${host}'`
  );
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/', (req, res) => res.redirect('/app'));

// ─── REST API ─────────────────────────────────────────────
app.get('/vehicles', (req, res) => {
  res.json({ ok: true, count: vehicles.length, lastSync, status: syncStatus, vehicles });
});

app.get('/vehicles/:id', (req, res) => {
  const v = vehicles.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, vehicle: v });
});

app.get('/status', (req, res) => {
  res.json({
    ok: syncStatus !== 'error',
    syncStatus, syncError, lastSync,
    vehicleCount: vehicles.length,
    pollInterval: POLL_INTERVAL,
    user: SPHEREGT_USER ? SPHEREGT_USER.substring(0,3) + '***' : 'NOT SET',
    env: process.env.RAILWAY_ENVIRONMENT || 'local',
  });
});

app.post('/refresh', async (req, res) => {
  await pollVehicles();
  res.json({ ok: true, vehicleCount: vehicles.length, lastSync });
});

// ─── Bridge dashboard ─────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html><html>
<head><title>TRAZA Bridge</title><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;background:#0a0a0f;color:#f2f2f8;padding:24px}
h1{color:#2d7eff;font-size:28px;margin-bottom:4px}
.sub{color:#5a5a72;font-size:11px;letter-spacing:.15em;text-transform:uppercase;margin-bottom:28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
.card{background:#16161f;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:18px}
.lbl{color:#5a5a72;font-size:9px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
.val{font-size:26px;font-weight:700}
.ok{color:#00e096}.err{color:#ff3b5c}.warn{color:#ffd426}
a{color:#2d7eff;margin-right:18px;font-size:13px}
button{background:#2d7eff;color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;margin-top:14px;font-family:monospace}
@media(max-width:480px){.grid{grid-template-columns:1fr 1fr}}
</style></head><body>
<h1>⚡ TRAZA Bridge</h1>
<div class="sub">SphereGT · GlobalTrack MX · Live GPS</div>
<div class="grid">
  <div class="card"><div class="lbl">Status</div><div class="val" id="s">—</div></div>
  <div class="card"><div class="lbl">Vehicles</div><div class="val" id="c">—</div></div>
  <div class="card"><div class="lbl">Last Sync</div><div class="val" style="font-size:14px;padding-top:6px" id="t">—</div></div>
</div>
<div class="card" style="padding:16px">
  <a href="/app">🚗 TRAZA App</a>
  <a href="/vehicles">📡 /vehicles</a>
  <a href="/status">🔍 /status</a>
</div>
<button onclick="force()">⟳ Force Sync</button>
<script>
async function load(){
  const d=await fetch('/status').then(r=>r.json()).catch(()=>({}));
  const el=document.getElementById('s');
  el.textContent=d.syncStatus||'?';
  el.className='val '+(d.ok?'ok':d.syncStatus==='syncing'?'warn':'err');
  document.getElementById('c').textContent=d.vehicleCount??'—';
  document.getElementById('t').textContent=d.lastSync?new Date(d.lastSync).toLocaleTimeString():'Never';
}
async function force(){await fetch('/refresh',{method:'POST'});load();}
load();setInterval(load,5000);
</script></body></html>`);
});

// ─── Puppeteer browser ────────────────────────────────────
async function launchBrowser() {
  console.log('🌐 Launching browser...');
  if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });

  browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: SESSION_PATH,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });
  page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image','font','media','stylesheet'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  page.on('response', async response => {
    const url = response.url();
    if (/unit|vehicle|position|gps|device|asset|tracker/i.test(url)) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const body = await response.json().catch(() => null);
          if (body) parseVehicleResponse(url, body);
        }
      } catch (_) {}
    }
  });
  console.log('✅ Browser ready');
}

async function login() {
  console.log('Logging into SphereGT...');
  syncStatus = 'syncing';
  try {
    await page.goto(SPHEREGT_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    // Wait a bit for JS-rendered forms
    await new Promise(r => setTimeout(r, 3000));

    // Dump all inputs for debugging
    const inputInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, className: i.className }));
    });
    console.log('Inputs found on page:', JSON.stringify(inputInfo));

    // Try to fill using evaluate (bypasses clickability issues)
    const filled = await page.evaluate((user, pass) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userInput = inputs.find(i =>
        ['email','text','username','user'].includes(i.type) ||
        ['email','username','user','login','correo','usuario'].includes((i.name||'').toLowerCase()) ||
        ['email','username','user','login'].includes((i.id||'').toLowerCase()) ||
        (i.placeholder||'').toLowerCase().includes('user') ||
        (i.placeholder||'').toLowerCase().includes('email') ||
        (i.placeholder||'').toLowerCase().includes('correo') ||
        (i.placeholder||'').toLowerCase().includes('usuario')
      );
      const passInput = inputs.find(i =>
        i.type === 'password' ||
        ['password','pass','contrasena','clave'].includes((i.name||'').toLowerCase()) ||
        (i.placeholder||'').toLowerCase().includes('password') ||
        (i.placeholder||'').toLowerCase().includes('contrase')
      );
      if (!userInput || !passInput) return { ok: false, reason: 'fields not found' };
      // Set value and trigger React/Vue events
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(userInput, user);
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      userInput.dispatchEvent(new Event('change', { bubbles: true }));
      nativeInputValueSetter.call(passInput, pass);
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, userField: userInput.name || userInput.id, passField: passInput.name || passInput.id };
    }, SPHEREGT_USER, SPHEREGT_PASS);

    console.log('Fill result:', JSON.stringify(filled));
    if (!filled.ok) throw new Error('Could not fill login fields: ' + filled.reason);

    await new Promise(r => setTimeout(r, 500));

    // Click submit button
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"],input[type="submit"],button.login,button.btn-login,.btn-primary,button');
      if (btn) { btn.click(); return btn.textContent || btn.type; }
      // Try submitting the form directly
      const form = document.querySelector('form');
      if (form) { form.submit(); return 'form.submit()'; }
      return null;
    });
    console.log('Submit via:', submitted);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    const finalUrl = page.url();
    console.log('After login URL:', finalUrl);

    if (finalUrl.includes('login')) {
      throw new Error('Still on login page after submit — check credentials');
    }
    console.log('Logged in successfully');
    return true;
  } catch (err) {
    syncStatus = 'error'; syncError = err.message;
    console.error('Login failed:', err.message);
    return false;
  }
}

function parseVehicleResponse(url, body) {
  let parsed = [];
  if (Array.isArray(body)) {
    parsed = body.map(normalizeVehicle).filter(Boolean);
  } else if (typeof body === 'object') {
    const list = body.data || body.units || body.vehicles || body.devices || body.assets || body.results;
    if (Array.isArray(list)) parsed = list.map(normalizeVehicle).filter(Boolean);
  }
  if (parsed.length > 0) {
    vehicles = parsed; lastSync = new Date().toISOString();
    syncStatus = 'ok'; syncError = null;
    console.log(`📡 ${parsed.length} vehicles synced`);
  }
}

function normalizeVehicle(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = parseFloat(v.lat ?? v.latitude  ?? v.lt ?? v.y ?? v.position?.lat ?? null);
  const lng = parseFloat(v.lng ?? v.longitude ?? v.lon ?? v.lo ?? v.x ?? v.position?.lng ?? null);
  if (isNaN(lat) || isNaN(lng)) return null;
  return {
    id:      String(v.id ?? v.unit_id ?? v.deviceId ?? v.imei ?? Math.random()),
    name:    String(v.name ?? v.label ?? v.alias ?? v.plate ?? v.patente ?? 'Vehicle'),
    lat, lng,
    speed:   parseFloat(v.speed  ?? v.velocidad ?? 0) || 0,
    heading: parseFloat(v.course ?? v.heading   ?? 0) || 0,
    status:  String(v.status ?? v.estado ?? 'unknown'),
    updated: v.updated_at ?? v.timestamp ?? v.lastUpdate ?? new Date().toISOString(),
  };
}

async function pollVehicles() {
  if (!page || !browser) return;
  syncStatus = 'syncing';
  try {
    await page.evaluate(() => {
      if (typeof refreshUnits === 'function') refreshUnits();
      if (typeof updateMap    === 'function') updateMap();
      if (typeof loadVehicles === 'function') loadVehicles();
      if (typeof getPositions === 'function') getPositions();
    }).catch(() => {});

    const domVehicles = await page.evaluate(() => {
      const globals = [window.units, window.vehicles, window.markers, window.devices, window.fleet, window.positions];
      for (const g of globals) {
        if (Array.isArray(g) && g.length > 0) return g;
        if (g && typeof g === 'object') {
          const vals = Object.values(g);
          if (vals.length > 0 && vals[0]?.lat) return vals;
        }
      }
      return null;
    }).catch(() => null);

    if (domVehicles?.length > 0) {
      const parsed = domVehicles.map(normalizeVehicle).filter(Boolean);
      if (parsed.length > 0) {
        vehicles = parsed; lastSync = new Date().toISOString();
        syncStatus = 'ok'; syncError = null;
        console.log(`🔄 ${parsed.length} vehicles from page state`);
      }
    } else {
      const url = page.url();
      if (!url.includes('login')) {
        await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      } else {
        console.log('⚠️  Session expired — re-logging in');
        await login();
      }
    }
    if (syncStatus === 'syncing') syncStatus = vehicles.length > 0 ? 'ok' : 'waiting';
  } catch (err) {
    syncStatus = 'error'; syncError = err.message;
    console.error('⚠️  Poll error:', err.message);
  }
}

// ─── Boot ─────────────────────────────────────────────────
async function start() {
  // Always start HTTP server first — never crash on missing credentials
  app.listen(PORT, '0.0.0.0', () => {
    console.log('TRAZA running on port ' + PORT);
    console.log('   App:       /app');
    console.log('   Dashboard: /dashboard');
    console.log('   API:       /vehicles');
  });

  if (!SPHEREGT_USER || !SPHEREGT_PASS) {
    console.warn('WARNING: SPHEREGT_USER / SPHEREGT_PASS not set.');
    console.warn('App is running but GPS bridge is disabled.');
    console.warn('Add them in Railway -> your service -> Variables tab.');
    syncStatus = 'waiting';
    return;
  }

  await launchBrowser();
  const ok = await login();
  if (ok) {
    await pollVehicles();
    setInterval(pollVehicles, POLL_INTERVAL);
    console.log(`🔁 Polling every ${POLL_INTERVAL / 1000}s\n`);
  }
}

process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(); });

start().catch(console.error);
