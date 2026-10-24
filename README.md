# Horyzont

PWA, która co 20 minut przypomina o oderwaniu wzroku od ekranu na 20 sekund.
Zainstalowana na Androidzie działa też przy zgaszonym ekranie — przez web push
z serwera, a nie przez timer w karcie przeglądarki.

```
https://horyzont.dev.jakbyco.com
```

## Co robi

- Domyślnie aktywne w dni robocze, 10:30–17:00, przypomnienie co 20 minut.
- Po stuknięciu w powiadomienie (albo w aplikacji) wchodzi ekran przerwy:
  20 sekund, pierścień odliczania, Wake Lock żeby ekran nie zgasł.
- Weekend jest domyślnie wyłączony, ale każdy dzień można włączyć ręcznie
  („Włącz na dziś”) — nadpisanie dotyczy tylko tego jednego dnia.
- Pauza: 30 minut, godzina albo do końca dnia.
- „Pomiń następną” przesuwa jedno przypomnienie.
- Ustawienia: okno, interwał, długość przerwy, dni tygodnia, dźwięk, wibracja.

## Dźwięk — co jest możliwe

Dwa różne mechanizmy, różne ograniczenia systemu:

| Sytuacja | Co gra | Kontrola |
| --- | --- | --- |
| Aplikacja otwarta | ton z Web Audio (`app.js` → `playCue`) | pełna: barwa, długość ~1,3 s, głośność |
| Telefon zablokowany | powiadomienie push | kanał powiadomień Chrome, zarządzany przez Androida |

Przeglądarka nie pozwala ustawić własnego pliku dźwiękowego dla powiadomienia
push — opcja `sound` w Notification API jest na Androidzie ignorowana. Można
natomiast zmienić dźwięk i głośność kanału samej aplikacji:
**przytrzymaj ikonę Horyzontu → Powiadomienia → kanał Horyzontu**.
Trybu Nie przeszkadzać nie da się obejść — to ograniczenie systemu, nie aplikacji.

## Architektura

```
public/            statyczny frontend (bez frameworka)
  index.html       jeden ekran + dialogi ustawień i pauzy
  styles.css       ciemny motyw, RWD 360 px → desktop
  app.js           harmonogram lokalny, audio, push, Wake Lock
  sw.js            offline shell + obsługa powiadomień
server.js          Express + web-push + harmonogram serwerowy
data/              subskrypcje (wolumen Dokku w produkcji)
```

Harmonogram jest liczony dwukrotnie i niezależnie: w przeglądarce (natychmiast,
offline) i na serwerze (push przy zamkniętej aplikacji). Serwer nie zlicza
„20 minut od startu”, tylko wylicza sloty jako `start + k · interwał` w strefie
`Europe/Warsaw` i co 15 s sprawdza, czy jakiś slot właśnie minął. Restart
procesu, zmiana czasu letniego czy wybudzenie telefonu nie powodują duplikatów
ani salwy zaległych powiadomień (spóźnione sloty są pomijane po 8 minutach).

## API

| Metoda | Ścieżka | Opis |
| --- | --- | --- |
| GET | `/api/health` | status, czas lokalny, liczba subskrypcji |
| GET | `/api/config` | klucz publiczny VAPID, domyślne ustawienia |
| POST | `/api/subscribe` | rejestracja subskrypcji push + ustawień |
| POST | `/api/settings` | aktualizacja harmonogramu |
| POST | `/api/pause` | pauza (`minutes` albo `until: "endOfDay"`), `resume: true` wznawia |
| POST | `/api/skip` | pomiń następny slot |
| POST | `/api/today` | ręczne włączenie/wyłączenie dzisiejszego dnia |
| POST | `/api/test` | natychmiastowe powiadomienie testowe |

## Uruchomienie lokalne

```bash
npm install
PORT=8081 DATA_DIR=./data node server.js
```

Klucze VAPID generują się same do `data/vapid.json`. Push wymaga HTTPS
(lub `localhost`), więc realny test powiadomień robi się na produkcji.

## Deploy (Dokku)

```bash
dokku apps:create horyzont
dokku domains:add horyzont horyzont.dev.jakbyco.com
mkdir -p /var/lib/dokku/data/storage/horyzont
chown 1000:1000 /var/lib/dokku/data/storage/horyzont
dokku storage:mount horyzont /var/lib/dokku/data/storage/horyzont:/data
dokku ports:set horyzont http:80:8080
dokku config:set --no-restart horyzont VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:...
git push dokku main
dokku letsencrypt:enable horyzont
```

Stan subskrypcji żyje na wolumenie `/data`, więc przetrwa przebudowę kontenera.

## Uwagi eksploatacyjne

- Android potrafi opóźniać push przy agresywnej optymalizacji baterii.
  Ustawienia → Aplikacje → Horyzont → Bateria → **Bez ograniczeń**.
- Subskrypcje wygasłe (404/410) są usuwane automatycznie przy wysyłce.
- Aplikacja nie zbiera żadnych danych poza endpointem push i harmonogramem;
  brak kont, brak analityki.
