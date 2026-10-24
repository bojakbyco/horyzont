import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HORYZONT_NO_LISTEN = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'horyzont-unit-'));

const { dueSlot, dayEnabled, sanitizeSettings, localNow, hmToMin } = await import('../server.js');

test('dueSlot trafia w sloty start + k*interwał', () => {
  const s = { start: '10:30', end: '17:00', interval: 20, breakSec: 20, days: [1, 2, 3, 4, 5], enabled: true };
  assert.equal(dueSlot(s, hmToMin('10:29')), null);
  assert.equal(dueSlot(s, hmToMin('10:30')).k, 0);
  assert.equal(dueSlot(s, hmToMin('10:49')).k, 0);
  assert.equal(dueSlot(s, hmToMin('10:50')).k, 1);
  assert.equal(dueSlot(s, hmToMin('12:30')).k, 6);
  const last = dueSlot(s, hmToMin('17:00'));
  assert.equal(last.k, 19);
  assert.equal(dueSlot(s, hmToMin('17:01')), null);
  assert.equal(dueSlot(s, hmToMin('09:00')), null);
});

test('dueSlot liczy spóźnienie slotu', () => {
  const s = { start: '10:30', end: '17:00', interval: 20 };
  assert.equal(dueSlot(s, hmToMin('10:37')).late, 7);
  assert.equal(dueSlot(s, hmToMin('10:38')).late, 8);
});

test('ręczne nadpisanie dnia wygrywa z dniami tygodnia', () => {
  const monday = { dayKey: '2026-10-26', weekday: 1 };
  const saturday = { dayKey: '2026-10-24', weekday: 6 };
  const sub = { settings: { days: [1, 2, 3, 4, 5] }, overrides: {} };
  assert.equal(dayEnabled(sub, monday), true);
  assert.equal(dayEnabled(sub, saturday), false);
  sub.overrides = { '2026-10-24': true };
  assert.equal(dayEnabled(sub, saturday), true);
  sub.overrides = { '2026-10-26': false };
  assert.equal(dayEnabled(sub, monday), false);
});

test('sanitizeSettings naprawia złe dane wejściowe', () => {
  const out = sanitizeSettings({ start: '18:00', end: '09:00', interval: 0, breakSec: 1000, days: [9, 2, 2] });
  assert.equal(out.start, '18:00');
  assert.equal(out.end, '19:00', 'koniec przed startem jest podnoszony o godzinę');
  assert.equal(out.interval, 20, 'interwał 0 → domyślne 20');
  assert.equal(out.breakSec, 180, 'przerwa przycięta do 180 s');
  assert.deepEqual(out.days, [2]);
  assert.equal(sanitizeSettings({}).start, '10:30');
  assert.deepEqual(sanitizeSettings({}).days, [1, 2, 3, 4, 5], 'weekend domyślnie wyłączony');
});

test('serwer: subskrypcja, push w suchym biegu, brak duplikatów, pauza, dzień', async () => {
  const now = localNow();
  const startMin = Math.max(0, now.minutes - 1);
  const start = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: '8099',
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'horyzont-run-')),
      HORYZONT_NO_LISTEN: '0',
      HORYZONT_DRY_PUSH: '1',
      TICK_MS: '400',
      GRACE_MIN: '8'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const base = 'http://127.0.0.1:8099';
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* jeszcze nie wstał */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  const healthRes = await fetch(`${base}/api/health`).catch((e) => ({ ok: false, err: e }));
  assert.equal(healthRes.ok, true, `serwer nie wstał:\n${log}`);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.tz, 'Europe/Warsaw');

  const subscription = {
    endpoint: 'https://push.example.com/abc',
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  };

  const subRes = await (await fetch(`${base}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, settings: { start, end: '23:59', interval: 20, breakSec: 20, days: [1, 2, 3, 4, 5, 6, 7] } })
  })).json();
  assert.equal(subRes.ok, true);
  assert.ok(subRes.id);

  await new Promise((r) => setTimeout(r, 2200));
  const pushes = (log.match(/DRY push/g) || []).length;
  assert.equal(pushes, 1, `oczekiwano dokładnie jednego pusha, było ${pushes}\n${log}`);

  // zmiana ustawień nie może wysypać serwera
  const setRes = await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, settings: { breakSec: 30 } })
  })).json();
  assert.equal(setRes.settings.breakSec, 30);
  assert.equal(setRes.settings.interval, 20, 'pozostałe pola zachowane');

  const pauseRes = await (await fetch(`${base}/api/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, until: 'endOfDay' })
  })).json();
  assert.equal(pauseRes.ok, true);
  assert.ok(pauseRes.pausedUntil > Date.now());

  const resumeRes = await (await fetch(`${base}/api/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, resume: true })
  })).json();
  assert.equal(resumeRes.pausedUntil, null);

  const todayRes = await (await fetch(`${base}/api/today`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, on: false })
  })).json();
  assert.equal(todayRes.override, false);
  assert.equal(todayRes.effective, false);

  const unsub = await (await fetch(`${base}/api/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  })).json();
  assert.equal(unsub.ok, true);

  child.kill('SIGTERM');
  await once(child, 'exit');
});
