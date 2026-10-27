/* Horyzont — warstwa natywna (Capacitor/Android).
   Ten plik jest bundlowany do public/native.js (esbuild), żeby przeglądarka
   nie musiała rozwiązywać importów z node_modules. W PWA wszystkie funkcje
   są bezpiecznymi no-opami. */

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const CHANNEL_ID = 'horyzont-v2';
const SOUND = 'horyzont'; // android/app/src/main/res/raw/horyzont.wav
const END_CHANNEL_ID = 'horyzont-end-v1';
const END_SOUND = 'horyzont_end'; // android/app/src/main/res/raw/horyzont_end.wav

export const isNative = () => Capacitor.isNativePlatform();

/** Tworzy kanał powiadomień z własnym dźwiękiem i pilnuje uprawnień. */
export async function initNative() {
  if (!isNative()) return { ok: false, reason: 'web' };

  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Przerwy 20-20-20',
      description: 'Przypomnienia o oderwaniu wzroku od ekranu',
      sound: SOUND,
      importance: 4,
      vibration: true,
      visibility: 1
    });

    await LocalNotifications.createChannel({
      id: END_CHANNEL_ID,
      name: 'Koniec przerwy',
      description: 'Dźwięk po zakończeniu 20 sekund przerwy',
      sound: END_SOUND,
      importance: 3,
      vibration: false,
      visibility: 1
    });

    const current = await LocalNotifications.checkPermissions();
    let display = current.display;
    if (display !== 'granted') {
      display = (await LocalNotifications.requestPermissions()).display;
    }
    if (display !== 'granted') return { ok: false, reason: 'permission' };

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

/** Otwiera systemowy ekran „Alarmy i przypomnienia” (jednorazowo, z UI). */
export async function requestExactAlarmSetting() {
  if (!isNative() || Capacitor.getPlatform() !== 'android') return;
  try {
    await LocalNotifications.changeExactNotificationSetting();
  } catch {
    /* starsze Androidy nie mają tego ekranu */
  }
}

/** Ponowne sprawdzenie dostępu do dokładnych alarmów (np. po powrocie z ustawień). */
export async function exactAlarmGranted() {
  if (!isNative() || Capacitor.getPlatform() !== 'android') return true;
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
    return status.exact_alarm === 'granted';
  } catch {
    return false;
  }
}

const idFor = (date) => Math.floor(date.getTime() / 60000) % 2000000000;

/** Planuje dokładnie wskazane terminy: przypomnienie + dźwięk końca przerwy. */
export async function scheduleNative(dates, { title, body, breakSec = 20 } = {}) {
  if (!isNative() || !Array.isArray(dates) || dates.length === 0) return 0;

  const pause = Math.max(5, Number(breakSec) || 20);
  const notifications = [];

  for (const at of dates) {
    const start = new Date(at);
    const end = new Date(start.getTime() + pause * 1000);

    notifications.push({
      id: idFor(start),
      title: title || 'Horyzont',
      body: body || 'Oderwij wzrok na 20 sekund',
      channelId: CHANNEL_ID,
      schedule: { at: start, allowWhileIdle: true },
      extra: { at: start.toISOString(), phase: 'start' }
    });

    notifications.push({
      id: idFor(start) + 1,
      title: 'Przerwa zakończona',
      body: 'Możesz wrócić do ekranu',
      channelId: END_CHANNEL_ID,
      schedule: { at: end, allowWhileIdle: true },
      extra: { at: start.toISOString(), phase: 'end' }
    });
  }

  await LocalNotifications.schedule({ notifications });
  return notifications.length;
}

/** Kasuje wszystkie oczekujące powiadomienia Horyzontu (przed przeliczeniem planu). */
export async function cancelNative() {
  if (!isNative()) return;
  const pending = await LocalNotifications.getPending();
  if (!pending.notifications?.length) return;
  await LocalNotifications.cancel({
    notifications: pending.notifications.map((n) => ({ id: n.id }))
  });
}

/** Stuknięcie w powiadomienie (także przy zimnym starcie). */
export function onNativeTap(handler) {
  if (!isNative()) return;
  LocalNotifications.addListener('localNotificationActionPerformed', () => handler());
}
