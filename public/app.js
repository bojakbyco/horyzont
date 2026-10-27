/* Horyzont — logika klienta
   Harmonogram liczymy lokalnie (natychmiast, offline), a serwer robi to samo
   niezależnie i wysyła web push, gdy aplikacja jest zamknięta. Wersja Android
   (Capacitor) nie ma serwera: planuje dokładne alarmy przez LocalNotifications. */

import { isNative, initNative, scheduleNative, cancelNative, onNativeTap, exactAlarmGranted, requestExactAlarmSetting } from './native.js';

const DEFAULTS = {
  start: '10:30',
  end: '17:00',
  interval: 20,
  breakSec: 20,
  days: [1, 2, 3, 4, 5],
  sound: true,
  volume: 0.55,
  vibrate: true
};

const STORE_KEY = 'horyzont.settings.v1';
const DONE_KEY = 'horyzont.done.v1';
const DAY_NAMES = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];

const $ = (id) => document.getElementById(id);
const el = {
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  todayToggle: $('todayToggle'),
  ringProgress: $('ringProgress'),
  ringLabel: $('ringLabel'),
  countdown: $('countdown'),
  countdownSub: $('countdownSub'),
  windowLabel: $('windowLabel'),
  slotCounter: $('slotCounter'),
  ticks: $('ticks'),
  statDone: $('statDone'),
  statInterval: $('statInterval'),
  statBreak: $('statBreak'),
  pauseBtn: $('pauseBtn'),
  skipBtn: $('skipBtn'),
  hint: $('hint'),
  installBanner: $('installBanner'),
  installHint: $('installHint'),
  installBtn: $('installBtn'),
  installBtn2: $('installBtn2'),
  installCard: $('installCard'),
  pauseSheet: $('pauseSheet'),
  resumeBtn: $('resumeBtn'),
  settingsSheet: $('settingsSheet'),
  openSettings: $('openSettings'),
  setStart: $('setStart'),
  setEnd: $('setEnd'),
  intervalChips: $('intervalChips'),
  breakChips: $('breakChips'),
  dayChips: $('dayChips'),
  setSound: $('setSound'),
  setVolume: $('setVolume'),
  volumeRow: $('volumeRow'),
  setVibrate: $('setVibrate'),
  testSound: $('testSound'),
  pushStatus: $('pushStatus'),
  enablePush: $('enablePush'),
  testPush: $('testPush'),
  focus: $('focus'),
  focusProgress: $('focusProgress'),
  focusCount: $('focusCount'),
  focusEnd: $('focusEnd'),
  toast: $('toast')
};

let settings = loadSettings();
let todayOverride = null;   // null = wg dni tygodnia, true/false = ręcznie na dziś
let pausedUntil = null;     // ms
let pushReady = false;
let nativeReady = false;
let vapidKey = null;
let deferredInstall = null;
let lastFiredKey = null;
let focusTimer = null;
let wakeLock = null;
let ticksCount = -1;

/* ------------------------------------------------------------- utilities */

function hmToMin(str, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

const fmtHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoWeekday = (d) => ((d.getDay() + 6) % 7) + 1; // 1 = poniedziałek
const minutesNow = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...DEFAULTS, ...raw, days: Array.isArray(raw.days) && raw.days.length ? raw.days : [...DEFAULTS.days] };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify(settings));
}

function doneMap() {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || '{}'); } catch { return {}; }
}

function doneToday() {
  return doneMap()[dayKey(new Date())] || 0;
}

function bumpDone() {
  const map = doneMap();
  const key = dayKey(new Date());
  map[key] = (map[key] || 0) + 1;
  const cutoff = dayKey(new Date(Date.now() - 21 * 864e5));
  for (const k of Object.keys(map)) if (k < cutoff) delete map[k];
  localStorage.setItem(DONE_KEY, JSON.stringify(map));
}

/* ------------------------------------------------------------ harmonogram */

function slotsForDay(dayDate) {
  const start = hmToMin(settings.start, 630);
  const end = hmToMin(settings.end, 1020);
  const step = Math.max(1, Number(settings.interval) || 20);
  const out = [];
  if (end <= start) return out;
  for (let t = start; t <= end; t += step) out.push(t);
  return out;
}

function dayEnabled(dayDate) {
  if (dayKey(dayDate) === dayKey(new Date()) && todayOverride !== null) return todayOverride;
  return settings.days.includes(isoWeekday(dayDate));
}

function nextSlot(from = new Date()) {
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    if (!dayEnabled(day)) continue;
    for (const min of slotsForDay(day)) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(min / 60), min % 60, 0, 0);
      if (at > from) return { at, min, offset };
    }
  }
  return null;
}

/* ------------------------------------------------- harmonogram natywny */

function nativeSlots(days = 7) {
  const now = Date.now();
  const from = pausedUntil && pausedUntil > now ? new Date(pausedUntil) : new Date(now + 5000);
  const out = [];

  for (let offset = 0; offset <= days; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    if (!dayEnabled(day)) continue;
    for (const min of slotsForDay(day)) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(min / 60), min % 60, 0, 0);
      if (at <= from) continue;
      if (`${dayKey(at)}#${min}` === lastFiredKey) continue; // „pomiń następną"
      out.push(at);
    }
  }
  return out.slice(0, 180);
}

let nativeArmTimer = null;
function armNative(delay = 120) {
  if (!nativeReady) return;
  clearTimeout(nativeArmTimer);
  nativeArmTimer = setTimeout(async () => {
    try {
      await cancelNative();
      await scheduleNative(nativeSlots(), { breakSec: Math.max(5, Number(settings.breakSec) || 20) });
    } catch (error) {
      console.warn('Horyzont: nie udało się zaplanować alarmów', error);
    }
  }, delay);
}

function currentSlotIndex(now = new Date()) {
  const slots = slotsForDay(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  let idx = -1;
  slots.forEach((m, i) => { if (m <= mins) idx = i; });
  return idx;
}

function computeStatus(now = new Date()) {
  if (pausedUntil && now.getTime() < pausedUntil) return 'paused';
  if (!dayEnabled(now)) return 'off';
  const mins = minutesNow(now);
  const start = hmToMin(settings.start, 630);
  const end = hmToMin(settings.end, 1020);
  return mins >= start && mins <= end ? 'active' : 'idle';
}

function relativeDayWord(at, now) {
  const a = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((a - b) / 864e5);
  if (diff === 0) return 'dziś';
  if (diff === 1) return 'jutro';
  return DAY_NAMES[isoWeekday(at) - 1];
}

/* ------------------------------------------------------------------ audio */

let audioCtx = null;

function audio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** Bardzo krótki, miękki ton: trzy sinusoidalne składowe, wolny atak, długie wybrzmienie. */
function playCue(level = settings.volume, kind = 'start') {
  const ctx = audio();
  if (!ctx || level <= 0) return;
  const t = ctx.currentTime;

  const cue = kind === 'end'
    ? { peak: 0.13, hold: 1.05, partials: [
        { f: 659.25, g: 0.5, d: 0.9 },
        { f: 987.77, g: 0.18, d: 0.7 }
      ] }
    : { peak: 0.16, hold: 1.35, partials: [
        { f: 784.0, g: 0.55, d: 1.2 },
        { f: 1174.66, g: 0.2, d: 0.9 },
        { f: 1567.98, g: 0.07, d: 0.6 }
      ] };

  const master = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2600;
  filter.Q.value = 0.4;
  filter.connect(master);
  master.connect(ctx.destination);
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(0.0001 + level * cue.peak, t + 0.09);
  master.gain.exponentialRampToValueAtTime(0.0001, t + cue.hold);

  for (const p of cue.partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = p.f;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(p.g, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + p.d);
    osc.connect(gain).connect(filter);
    osc.start(t);
    osc.stop(t + Math.max(p.d, cue.hold) + 0.05);
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  const now = new Date();
  const status = computeStatus(now);
  const slots = slotsForDay(now);
  const slotIdx = currentSlotIndex(now);
  const next = nextSlot(now);

  el.statusChip.dataset.state = status === 'off' ? 'off' : status === 'idle' ? 'off' : status;
  el.statusText.textContent =
    status === 'active' ? 'Aktywne' :
    status === 'paused' ? 'Pauza' :
    status === 'off' ? 'Dzień wyłączony' : 'Poza oknem';

  // ręczne włączanie/wyłączanie dzisiejszego dnia
  const todayOffByRule = !settings.days.includes(isoWeekday(now));
  if (status === 'off' && todayOffByRule) {
    el.todayToggle.hidden = false;
    el.todayToggle.textContent = 'Włącz na dziś';
  } else if (status === 'off' && todayOverride === false) {
    el.todayToggle.hidden = false;
    el.todayToggle.textContent = 'Przywróć harmonogram';
  } else {
    el.todayToggle.hidden = true;
  }

  // odliczanie
  let secondsLeft = 0;
  let fraction = 0;
  if (status === 'paused') {
    secondsLeft = (pausedUntil - now.getTime()) / 1000;
    el.ringLabel.textContent = 'pauza';
    el.countdownSub.textContent = 'wznawiam automatycznie';
    fraction = 0;
  } else if (next) {
    secondsLeft = (next.at - now) / 1000;
    el.ringLabel.textContent = status === 'active' ? 'następna przerwa' : 'następne okno';
    el.countdownSub.textContent = `${relativeDayWord(next.at, now)}, ${fmtHM(next.min)}`;
    const step = Math.max(1, Number(settings.interval) || 20) * 60;
    // pierścień kurczy się razem z licznikiem — ruch i liczba mówią to samo
    fraction = status === 'active' ? Math.min(1, Math.max(0, secondsLeft / step)) : 0;
  } else {
    el.ringLabel.textContent = 'brak zaplanowanych';
    el.countdownSub.textContent = 'włącz dni w ustawieniach';
  }

  el.countdown.textContent = fmtClock(secondsLeft);
  el.ringProgress.style.strokeDashoffset = String(615.75 * (1 - fraction));

  // pasek dnia
  el.windowLabel.textContent = `${settings.start} — ${settings.end}`;
  if (slots.length !== ticksCount) {
    el.ticks.innerHTML = '';
    for (let i = 0; i < slots.length; i++) {
      const b = document.createElement('span');
      b.className = 'tick';
      el.ticks.appendChild(b);
    }
    ticksCount = slots.length;
  }
  const mins = minutesNow(now);
  const active = status === 'active' || status === 'paused';
  [...el.ticks.children].forEach((tick, i) => {
    tick.className = 'tick';
    if (i === slotIdx && active) tick.classList.add('now');
    else if (slots[i] <= mins && active) tick.classList.add('done');
  });
  const remainingSlots = Math.max(0, slots.length - (slotIdx + 1));
  el.slotCounter.textContent = status === 'off' || !slots.length
    ? '—'
    : remainingSlots > 0
      ? `zostało ${remainingSlots} przerw`
      : 'koniec okna';
  el.ticks.setAttribute('aria-valuenow', String(slots.length ? Math.round(((slotIdx + 1) / slots.length) * 100) : 0));

  // statystyki
  const planned = dayEnabled(now) ? slots.length : 0;
  el.statDone.textContent = String(doneToday());
  el.statInterval.textContent = `${settings.interval} min`;
  el.statBreak.textContent = `${settings.breakSec} s`;

  // akcje
  el.pauseBtn.textContent = status === 'paused' ? 'Wznów' : 'Pauza';
  el.pauseBtn.disabled = status === 'off';
  el.skipBtn.disabled = status === 'off' || !next;
  el.resumeBtn.hidden = status !== 'paused';

  const hintActionable = status !== 'off' && status !== 'paused' && !pushReady;
  el.hint.textContent = status === 'off'
    ? 'Weekend jest domyślnie wolny. Możesz włączyć przypomnienia tylko na dziś.'
    : status === 'paused'
      ? `Przypomnienia wstrzymane do ${new Date(pausedUntil).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}.`
      : pushReady
        ? 'Powiadomienia push aktywne — działają też przy zgaszonym ekranie.'
        : 'Włącz powiadomienia, żeby działały w tle.';
  el.hint.classList.toggle('is-action', hintActionable);
  el.hint.disabled = !hintActionable && status === 'off';
}

/* ------------------------------------------------------------ focus mode */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* brak wsparcia / odmowa — nie blokuje przerwy */ }
}

function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch { /* ignore */ }
  wakeLock = null;
}

function startFocus() {
  const total = Math.max(5, Number(settings.breakSec) || 20);
  const startedAt = performance.now();
  el.focus.hidden = false;
  el.focus.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => el.focus.classList.add('is-open'));
  requestWakeLock();

  let done = false;
  const finish = (withChime = true) => {
    if (done) return;
    done = true;
    clearInterval(focusTimer);
    el.focus.classList.remove('is-open');
    releaseWakeLock();
    setTimeout(() => {
      el.focus.hidden = true;
      el.focus.setAttribute('aria-hidden', 'true');
    }, 400);
    bumpDone();
    render();
    // W APK dźwięk końca gra osobne powiadomienie natywne (WebAudio bywa
    // blokowane, gdy ekran jest zablokowany albo aplikacja w tle).
    if (withChime && !nativeReady) playCue(settings.volume, 'end');
    if (navigator.vibrate) navigator.vibrate(18);
  };

  const paint = () => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const left = Math.max(0, total - elapsed);
    el.focusCount.textContent = String(Math.ceil(left));
    el.focusProgress.style.strokeDashoffset = String(741.4 * Math.min(1, elapsed / total));
    if (left <= 0) finish();
  };

  paint();
  clearInterval(focusTimer);
  focusTimer = setInterval(paint, 100);
  el.focusEnd.onclick = () => finish(false);
}

/* ------------------------------------------------------------------- push */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function currentSubscription() {
  if (isNative() || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function ensureSubscription({ interaction = false } = {}) {
  if (isNative() || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  if (Notification.permission === 'default' && interaction) {
    await Notification.requestPermission();
  }
  if (Notification.permission !== 'granted') return null;

  let sub = await currentSubscription();
  if (!sub) {
    if (!vapidKey) throw new Error('brak klucza VAPID');
    sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey)
    });
  }
  await api('/api/subscribe', { subscription: sub.toJSON(), settings: serverSettings() });
  pushReady = true;
  updatePushStatus();
  return sub;
}

function serverSettings() {
  return {
    start: settings.start,
    end: settings.end,
    interval: Number(settings.interval),
    breakSec: Number(settings.breakSec),
    days: settings.days,
    enabled: true
  };
}

let syncTimer = null;
function syncSettings() {
  if (isNative()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const sub = await currentSubscription().catch(() => null);
    if (!sub) return;
    try {
      await api('/api/settings', { endpoint: sub.endpoint, settings: serverSettings() });
    } catch { /* offline — serwer nadrobi przy następnym otwarciu */ }
  }, 700);
}

function updatePushStatus() {
  if (isNative() || !el.pushStatus) return;
  if (!('Notification' in window)) {
    el.pushStatus.textContent = 'niedostępne';
    el.enablePush.disabled = true;
    return;
  }
  el.pushStatus.textContent =
    Notification.permission === 'granted' && pushReady ? 'aktywne' :
    Notification.permission === 'granted' ? 'brak subskrypcji' :
    Notification.permission === 'denied' ? 'zablokowane w systemie' : 'nie włączone';
  el.enablePush.textContent = Notification.permission === 'granted' ? 'Odśwież subskrypcję' : 'Włącz powiadomienia';
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------ interakcje */

el.openSettings.addEventListener('click', () => {
  el.setStart.value = settings.start;
  el.setEnd.value = settings.end;
  syncChips();
  el.settingsSheet.showModal();
  updatePushStatus();
});

function syncChips() {
  [...el.intervalChips.children].forEach((b) => b.classList.toggle('is-active', Number(b.dataset.interval) === Number(settings.interval)));
  [...el.breakChips.children].forEach((b) => b.classList.toggle('is-active', Number(b.dataset.break) === Number(settings.breakSec)));
  [...el.dayChips.children].forEach((b) => b.classList.toggle('is-active', settings.days.includes(Number(b.dataset.day))));
  el.setSound.checked = settings.sound;
  el.setVolume.value = String(Math.round(settings.volume * 100));
  const volOut = document.getElementById('volumeValue');
  if (volOut) volOut.textContent = `${el.setVolume.value}%`;
  el.setVibrate.checked = settings.vibrate;
  el.volumeRow.style.display = settings.sound ? '' : 'none';
}

el.intervalChips.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-interval]');
  if (!btn) return;
  settings.interval = Number(btn.dataset.interval);
  commitSettings();
});

el.breakChips.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-break]');
  if (!btn) return;
  settings.breakSec = Number(btn.dataset.break);
  commitSettings();
});

el.dayChips.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-day]');
  if (!btn) return;
  const day = Number(btn.dataset.day);
  settings.days = settings.days.includes(day) ? settings.days.filter((d) => d !== day) : [...settings.days, day].sort();
  if (day === isoWeekday(new Date())) todayOverride = null;
  commitSettings();
});

el.setStart.addEventListener('change', () => {
  if (!el.setStart.value) return;
  settings.start = el.setStart.value;
  commitSettings();
});

el.setEnd.addEventListener('change', () => {
  if (!el.setEnd.value) return;
  settings.end = el.setEnd.value;
  commitSettings();
});

el.setSound.addEventListener('change', () => {
  settings.sound = el.setSound.checked;
  commitSettings();
});

el.setVolume.addEventListener('input', () => {
  settings.volume = Number(el.setVolume.value) / 100;
  saveSettings();
  const out = document.getElementById('volumeValue');
  if (out) out.textContent = `${el.setVolume.value}%`;
});

el.setVolume.addEventListener('change', () => {
  playCue(settings.volume);
  syncSettings();
});

el.setVibrate.addEventListener('change', () => {
  settings.vibrate = el.setVibrate.checked;
  commitSettings();
});

el.testSound.addEventListener('click', () => {
  audio();
  playCue(settings.volume);
});

function commitSettings() {
  saveSettings();
  ticksCount = -1;
  syncChips();
  render();
  syncSettings();
  armNative();
}

el.pauseBtn.addEventListener('click', () => {
  if (computeStatus() === 'paused') {
    resume();
    return;
  }
  el.pauseSheet.showModal();
});

el.pauseSheet.querySelectorAll('[data-pause]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.pause;
    const minutes = value === 'eod'
      ? Math.max(1, hmToMin(settings.end, 1020) - minutesNow() + 1)
      : Number(value);
    pausedUntil = Date.now() + minutes * 60000;
    el.pauseSheet.close();
    render();
    armNative();
    toast(`Wstrzymane na ${value === 'eod' ? 'resztę dnia' : `${minutes} min`}`);
    const sub = await currentSubscription().catch(() => null);
    if (sub) {
      try {
        await api('/api/pause', {
          endpoint: sub.endpoint,
          ...(value === 'eod' ? { until: 'endOfDay' } : { minutes })
        });
      } catch { /* offline */ }
    }
  });
});

el.resumeBtn.addEventListener('click', resume);

async function resume() {
  pausedUntil = null;
  el.pauseSheet.close?.();
  render();
  armNative();
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    try { await api('/api/pause', { endpoint: sub.endpoint, resume: true }); } catch { /* offline */ }
  }
}

el.skipBtn.addEventListener('click', async () => {
  const next = nextSlot();
  if (!next) return;
  // lokalnie oznaczamy slot jako obsłużony, żeby nie odpalił w aplikacji
  lastFiredKey = `${dayKey(next.at)}#${next.min}`;
  armNative(0);
  toast(`Pominięto przerwę o ${fmtHM(next.min)}`);
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    try { await api('/api/skip', { endpoint: sub.endpoint }); } catch { /* offline */ }
  }
});

el.todayToggle.addEventListener('click', async () => {
  todayOverride = todayOverride === false ? null : true;
  if (!todayOverride && !settings.days.includes(isoWeekday(new Date()))) todayOverride = true;
  render();
  armNative();
  toast(todayOverride ? 'Włączone na dziś' : 'Przywrócono harmonogram');
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    try { await api('/api/today', { endpoint: sub.endpoint, on: todayOverride }); } catch { /* offline */ }
  }
});

el.enablePush.addEventListener('click', async () => {
  try {
    const sub = await ensureSubscription({ interaction: true });
    if (sub) {
      toast('Powiadomienia włączone');
      try { await api('/api/test', { endpoint: sub.endpoint }); } catch { /* ignore */ }
    } else {
      toast('Brak zgody na powiadomienia');
    }
  } catch (err) {
    toast(`Nie udało się: ${err.message}`);
  }
  updatePushStatus();
});

el.testPush.addEventListener('click', async () => {
  try {
    const sub = await ensureSubscription({ interaction: true });
    if (!sub) return toast('Najpierw włącz powiadomienia');
    await api('/api/test', { endpoint: sub.endpoint });
    toast('Wysłane — sprawdź powiadomienia');
  } catch (err) {
    toast(`Błąd: ${err.message}`);
  }
});

/* --------------------------------------------------------------- instalacja */

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const installDismissed = () => localStorage.getItem('horyzont.installDismissed') === '1';

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (!isStandalone()) {
    el.installBanner.hidden = installDismissed();
    el.installCard.hidden = false;
  }
});

async function doInstall() {
  if (deferredInstall) {
    deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    if (outcome === 'accepted') {
      el.installBanner.hidden = true;
      el.installCard.hidden = true;
    }
    deferredInstall = null;
    return;
  }
  toast('Menu przeglądarki → „Dodaj do ekranu głównego"');
}

el.installBtn.addEventListener('click', doInstall);
el.installBtn2.addEventListener('click', doInstall);
$('installDismiss')?.addEventListener('click', () => {
  el.installBanner.hidden = true;
  localStorage.setItem('horyzont.installDismissed', '1');
});

el.hint.addEventListener('click', () => {
  if (el.hint.classList.contains('is-action')) el.openSettings.click();
});

if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalone()) {
  el.installBanner.hidden = installDismissed();
  el.installHint.textContent = 'Safari → Udostępnij → „Dodaj do ekranu początkowego".';
}

/* --------------------------------------------------------------- scheduler */

function fireLocalReminder() {
  if (settings.sound) {
    audio();
    playCue(settings.volume);
  }
  if (settings.vibrate && navigator.vibrate) navigator.vibrate([70, 60, 70]);
  startFocus();
}

function localTick() {
  const now = new Date();
  const status = computeStatus(now);
  if (status === 'active' && document.visibilityState === 'visible') {
    const mins = minutesNow(now);
    const slots = slotsForDay(now);
    const idx = currentSlotIndex(now);
    if (idx >= 0) {
      const key = `${dayKey(now)}#${slots[idx]}`;
      const slotDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(slots[idx] / 60), slots[idx] % 60, 0, 0);
      const late = (now - slotDate) / 1000;
      if (key !== lastFiredKey && late >= 0 && late <= 45) {
        lastFiredKey = key;
        fireLocalReminder();
      }
    }
  }
  render();
}

setInterval(localTick, 500);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // doszliśmy do wniosku, że nie nadrabiamy zaległych przypomnień po powrocie
    render();
  }
});

/* ------------------------------------------------------------------- start */

async function boot() {
  el.setStart.value = settings.start;
  el.setEnd.value = settings.end;
  syncChips();
  render();

  if (isNative()) {
    document.body.classList.add('native');

    const result = await initNative();
    nativeReady = result.ok;

    // W APK nie ma web pusha ani instalacji PWA — chowamy te sekcje.
    el.enablePush?.closest('.block-card')?.remove();
    el.installCard?.remove();
    el.installBanner?.remove();

    if (nativeReady) {
      onNativeTap(() => startFocus());
      armNative(0);

      if (!(await exactAlarmGranted())) {
        const asked = localStorage.getItem('horyzont.exactAsked') === '1';
        if (!asked) {
          localStorage.setItem('horyzont.exactAsked', '1');
          await requestExactAlarmSetting();
        } else {
          toast('Włącz „Alarmy i przypomnienia” dla Horyzontu w ustawieniach');
        }
      }
    } else {
      toast(result.reason === 'permission'
        ? 'Włącz powiadomienia dla Horyzontu w ustawieniach Androida'
        : 'Powiadomienia systemowe niedostępne');
    }

    // Po powrocie z ustawień (alarmy dokładne / bateria) dozbrajamy plan.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !nativeReady) return;
      if (!(await exactAlarmGranted())) return;
      armNative(600);
    });
  } else {
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { /* dev bez SW */ }
    }

    try {
      const cfg = await api('/api/config');
      vapidKey = cfg.publicKey;
    } catch { /* offline */ }

    updatePushStatus();
    if (Notification?.permission === 'granted') {
      ensureSubscription().catch(() => {});
    }

    // powiadomienia systemowe obsługiwane tutaj, gdy aplikacja jest na wierzchu
    navigator.serviceWorker?.addEventListener?.('message', (event) => {
      if (event.data?.type === 'horyzont:gaze') {
        if (document.visibilityState === 'visible') startFocus();
      }
    });
  }

  if (new URLSearchParams(location.search).get('focus') === '1') {
    history.replaceState(null, '', '/');
    setTimeout(startFocus, 350);
  }
}

boot();
