import express from 'express';
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || './data';
const TZ = process.env.APP_TZ || 'Europe/Warsaw';
const GRACE_MIN = Number(process.env.GRACE_MIN || 8);
const TICK_MS = Number(process.env.TICK_MS || 15000);

fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE = path.join(DATA_DIR, 'subscribers.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

/* ---------------------------------------------------------------- vapid */

function loadVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@jakbyco.com';
  if (pub && priv) return { publicKey: pub, privateKey: priv, subject };
  if (fs.existsSync(VAPID_FILE)) {
    const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    return { ...saved, subject };
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  console.log('[horyzont] wygenerowano lokalne klucze VAPID w', VAPID_FILE);
  return { ...keys, subject };
}

const vapid = loadVapid();
webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

/* ---------------------------------------------------------------- store */

const DEFAULT_SETTINGS = {
  start: '10:30',
  end: '17:00',
  interval: 20,
  breakSec: 20,
  days: [1, 2, 3, 4, 5],
  enabled: true
};

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return Array.isArray(raw.subscribers) ? raw.subscribers : [];
  } catch {
    return [];
  }
}

let subscribers = loadStore();
let saveTimer = null;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STORE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ subscribers }, null, 2));
      fs.renameSync(tmp, STORE);
    } catch (err) {
      console.error('[horyzont] zapis stanu nieudany:', err.message);
    }
  }, 120).unref?.();
}

/* ----------------------------------------------------------------- time */

function hmToMin(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function localNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: wd,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    seconds: Number(get('second'))
  };
}

/** Index of the reminder slot that is due at `minutes`, or null. */
function dueSlot(settings, minutes) {
  const start = hmToMin(settings.start, 630);
  const end = hmToMin(settings.end, 1020);
  const interval = Math.min(240, Math.max(1, Number(settings.interval) || 20));
  if (end <= start) return null;
  if (minutes < start || minutes > end) return null;
  const k = Math.floor((minutes - start) / interval);
  const slotMin = start + k * interval;
  if (slotMin > end) return null;
  return { k, slotMin, late: minutes - slotMin };
}

/* ------------------------------------------------------------ scheduler */

/** Ręczne nadpisanie dla konkretnego dnia ma pierwszeństwo nad dniami tygodnia. */
function dayEnabled(sub, now) {
  const override = sub.overrides?.[now.dayKey];
  if (typeof override === 'boolean') return override;
  return sub.settings.days.includes(now.weekday);
}

function sanitizeSettings(input = {}) {
  const start = hmToMin(input.start, hmToMin(DEFAULT_SETTINGS.start, 630));
  const end = hmToMin(input.end, hmToMin(DEFAULT_SETTINGS.end, 1020));
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort()
    : [...DEFAULT_SETTINGS.days];
  return {
    start: fmtHM(start),
    end: fmtHM(end > start ? end : start + 60),
    interval: Math.min(240, Math.max(1, Number(input.interval) || DEFAULT_SETTINGS.interval)),
    breakSec: Math.min(180, Math.max(5, Number(input.breakSec) || DEFAULT_SETTINGS.breakSec)),
    days: days.length ? days : [...DEFAULT_SETTINGS.days],
    enabled: input.enabled !== false
  };
}

function fmtHM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function buildPayload(sub) {
  const s = sub.settings;
  const end = hmToMin(s.end, 1020);
  const start = hmToMin(s.start, 630);
  const total = Math.max(1, Math.floor((end - start) / s.interval) + 1);
  const now = localNow();
  const k = dueSlot(s, Math.min(Math.max(now.minutes, start), end))?.k ?? 0;
  return {
    title: 'Oderwij wzrok',
    body: `${s.breakSec} s patrzenia w dal · ${k + 1}/${total}`,
    breakSec: s.breakSec,
    slot: k + 1,
    total,
    tag: 'horyzont-gaze',
    url: '/?focus=1',
    vibrate: [70, 60, 70],
    ts: Date.now()
  };
}

async function pushTo(sub, payload, { dryRun = false } = {}) {
  if (dryRun || process.env.HORYZONT_DRY_PUSH === '1') {
    console.log(`[horyzont] DRY push ${sub.id}: ${payload.title} — ${payload.body}`);
    sub.lastSentAt = new Date().toISOString();
    return { ok: true, dryRun: true };
  }
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), {
      TTL: 300,
      urgency: 'normal',
      topic: 'horyzont'
    });
    sub.lastSentAt = new Date().toISOString();
    return { ok: true };
  } catch (err) {
    const code = err?.statusCode;
    console.warn(`[horyzont] push ${sub.id} → ${code || err.message}`);
    if (code === 404 || code === 410) return { ok: false, gone: true };
    return { ok: false, code };
  }
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = localNow();
    let changed = false;

    for (const sub of subscribers) {
      const s = sub.settings;
      const due = dueSlot(s, now.minutes);
      const stamp = new Date().toISOString();
      sub.lastSeenAt = stamp;

      if (!due) continue;

      const key = `${now.dayKey}#${due.k}`;
      if (sub.lastSlot === key) continue;

      if (due.late > GRACE_MIN) {
        // Serwer był wyłączony — nie zasypujemy użytkownika zaległymi alertami.
        sub.lastSlot = key;
        changed = true;
        continue;
      }
      if (!s.enabled || !dayEnabled(sub, now)) {
        sub.lastSlot = key;
        changed = true;
        continue;
      }
      if (sub.pausedUntil && Date.now() < sub.pausedUntil) {
        sub.lastSlot = key;
        changed = true;
        continue;
      }
      if (sub.skipNext) {
        sub.skipNext = false;
        sub.lastSlot = key;
        changed = true;
        console.log(`[horyzont] ${sub.id}: pominięto slot ${key}`);
        continue;
      }

      const payload = buildPayload(sub);
      const res = await pushTo(sub, payload);
      sub.lastSlot = key;
      changed = true;

      if (res.gone) {
        subscribers = subscribers.filter((x) => x.id !== sub.id);
        console.log(`[horyzont] ${sub.id}: usunięto wygasłą subskrypcję`);
      }
    }

    if (changed) persist();
  } catch (err) {
    console.error('[horyzont] tick error:', err);
  } finally {
    ticking = false;
  }
}

setInterval(tick, TICK_MS).unref?.();
setTimeout(tick, 1200);

/* ---------------------------------------------------------------- routes */

const app = express();
app.use(express.json({ limit: '64kb' }));
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/api/health', (req, res) => {
  const now = localNow();
  res.json({
    ok: true,
    tz: TZ,
    localTime: `${now.dayKey} ${fmtHM(now.minutes)}`,
    subscribers: subscribers.length,
    vapid: Boolean(vapid.publicKey)
  });
});

app.get('/api/config', (req, res) => {
  res.json({ publicKey: vapid.publicKey, tz: TZ, defaults: DEFAULT_SETTINGS });
});

function findSub(body) {
  const endpoint = body?.subscription?.endpoint || body?.endpoint;
  if (!endpoint) return null;
  return subscribers.find((s) => s.subscription?.endpoint === endpoint) || null;
}

app.post('/api/subscribe', (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'brak poprawnej subskrypcji' });
  }
  const settings = sanitizeSettings(req.body.settings);
  const existing = findSub(req.body);
  if (existing) {
    existing.subscription = subscription;
    existing.settings = settings;
    existing.lastSeenAt = new Date().toISOString();
    persist();
    return res.json({ ok: true, id: existing.id, updated: true });
  }
  const sub = {
    id: crypto.randomUUID(),
    subscription,
    settings,
    overrides: {},
    lastSlot: null,
    skipNext: false,
    pausedUntil: null,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastSentAt: null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 160)
  };
  subscribers.push(sub);
  persist();
  console.log(`[horyzont] nowa subskrypcja ${sub.id} (${subscribers.length} łącznie)`);
  res.json({ ok: true, id: sub.id, created: true });
});

app.post('/api/settings', (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  sub.settings = sanitizeSettings({ ...sub.settings, ...req.body.settings });
  sub.lastSlot = null; // pozwól przeliczyć harmonogram od nowa
  persist();
  res.json({ ok: true, settings: sub.settings });
});

app.post('/api/pause', (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  if (req.body.resume) {
    sub.pausedUntil = null;
    sub.lastSlot = null;
    persist();
    return res.json({ ok: true, pausedUntil: null });
  }
  let minutes = Number(req.body.minutes) || 30;
  if (req.body.until === 'endOfDay') {
    const now = localNow();
    const end = hmToMin(sub.settings.end, 1020);
    minutes = Math.max(1, end - now.minutes) + 1;
  }
  sub.pausedUntil = Date.now() + Math.min(1440, Math.max(1, minutes)) * 60000;
  persist();
  res.json({ ok: true, pausedUntil: sub.pausedUntil, minutes });
});

/** Ręczne włączenie/wyłączenie dzisiejszego dnia (np. praca w weekend). */
app.post('/api/today', (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  const now = localNow();
  const on = req.body.on;
  if (on === null || on === 'auto') {
    delete sub.overrides?.[now.dayKey];
  } else {
    sub.overrides = sub.overrides || {};
    sub.overrides[now.dayKey] = Boolean(on);
  }
  // czyścimy wpisy starsze niż 14 dni
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(sub.overrides || {})) {
    if (key < cutoff) delete sub.overrides[key];
  }
  sub.lastSlot = null;
  persist();
  res.json({
    ok: true,
    today: now.dayKey,
    override: sub.overrides?.[now.dayKey] ?? null,
    effective: dayEnabled(sub, now)
  });
});

app.post('/api/skip', (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  sub.skipNext = true;
  persist();
  res.json({ ok: true });
});

app.post('/api/test', async (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  const payload = {
    ...buildPayload(sub),
    title: 'Horyzont — test',
    body: 'Tak wygląda przypomnienie. Oderwij wzrok na 20 sekund.',
    slot: null,
    total: null
  };
  const out = await pushTo(sub, payload);
  if (out.gone) {
    subscribers = subscribers.filter((x) => x.id !== sub.id);
    persist();
    return res.status(410).json({ error: 'subskrypcja wygasła — zainstaluj ponownie' });
  }
  persist();
  res.json(out);
});

app.post('/api/unsubscribe', (req, res) => {
  const sub = findSub(req.body);
  if (!sub) return res.status(404).json({ error: 'nieznana subskrypcja' });
  subscribers = subscribers.filter((x) => x.id !== sub.id);
  persist();
  res.json({ ok: true });
});

/* --------------------------------------------------------------- static */

const PUBLIC_DIR = path.resolve('public');

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (/\.(woff2|png|svg)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/sw\.js$|manifest\.webmanifest$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    }
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (process.env.HORYZONT_NO_LISTEN !== '1') {
  app.listen(PORT, '0.0.0.0', () => {
    const now = localNow();
    console.log(`[horyzont] start na :${PORT} · ${TZ} · lokalnie ${now.dayKey} ${fmtHM(now.minutes)} · ${subscribers.length} subskrypcji`);
  });
}

export { app, dueSlot, dayEnabled, sanitizeSettings, localNow, hmToMin, fmtHM };
