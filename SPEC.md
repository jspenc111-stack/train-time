# Leave By — Spec (v2.3)

A personal app that watches my Google Calendar and tells me **when to leave** and **which subway to take**, so I arrive 0–10 minutes before each in-person NYC event.

## 1. What it does

- For each event today that has an NYC location, it plans the trip:
  - from **home** (my nearest station, a short walk away, set in the app), or
  - from **my previous event**, if that one ends shortly before.
- It sends up to 3 phone notifications per event:
  1. **Heads-up**, 90 min before leaving, listing the train options.
  2. **Warning**, about 15 min before leaving.
  3. **Leave now**.

  If plans change after the heads-up, it sends a short **"Change: leave 6:05 (was 6:12)"**.
- It prefers a train that lands a few minutes early over one that's cutting it close.
- It steers around lines with active MTA delays. If there's no way around them, it tells me to leave 5 minutes earlier.
- It suggests walking when the place is close and walking isn't much slower than the train.
- It tells me once, with time to fix it, when it can't plan an event: the location is too vague, the place can't be found, or there's no route.
- A **Skip** button (on the notification and in the app) silences one event, for plans I'm not actually going to.
- The app shows today's plan. Tapping a train or walk option opens directions in Google Maps or Citymapper.
- All settings are editable in the app, with no code editing needed.

**Out of scope:** events outside NYC (shown but silent), live "train arrives in 3 min" countdowns, and weather.

## 2. How it fits together

```
Google Calendar ──► Google Apps Script (my account, runs every 5 min, free)
                     ├─ Google Maps: find places + subway/walking directions (no API key needed)
                     ├─ MTA subway alerts feed (best effort)
                     ├─ Web push "doorbell" (empty) ──► phone's push service ──► Leave By app wakes up
                     └─ Web API ◄──► Leave By app (PWA on GitHub Pages): plans, settings, skip, message inbox
```

- **Backend** (`apps-script/Code.gs`): Google Apps Script. It reads my calendar directly and uses Apps Script's built-in Maps service, so there is no Google Cloud project, API key, or billing.
- **Notifications** ("doorbells", §4.5):
  1. The backend keeps each message in an **outbox** and sends an **empty** web push to each registered phone.
  2. The installed app's service worker wakes up, fetches the message text from the backend's `inbox`, and shows it.
  3. The push service (Google's, for Chrome on Android) only ever sees an empty signal.
- **App** (`web/`): a static PWA, deployed to GitHub Pages by a GitHub Actions workflow on every push to `main`. Notifications only work in the **installed** app.

**Why web push signing is done by hand:** push services only accept a push that carries a token (a JWT) signed with an ECDSA P-256 key ("VAPID"). Apps Script has no built-in ECDSA, so `Code.gs` does the curve math itself with `BigInt` (§4.8). Message text never goes through the push service, so no payload encryption is needed.

**Why not a public notification relay (used before v2.3):** the free public server limited messages per internet address. Apps Script calls come from Google's shared addresses, so strangers used up the daily quota.

## 3. Settings

Settings are edited in the app (⚙︎). They're stored in Script Properties under `SETTINGS`, with defaults in `DEFAULTS`. Every value is range-checked when saved.

| Setting | Default | Meaning |
|---|---|---|
| Leaving from (`homeAddress`) | *(blank; set in the app)* | Where trips from home start. Blank means events show "Set where you leave from" and the app shows a banner. Kept out of the code because the repo is public. |
| Walk to it (`walkToStationMin`) | 5 | Home → that station |
| Arrive at least / at most (`minEarlyMin` / `maxEarlyMin`) | 0 / 10 | Arrival window |
| `comfortMin` (not in UI) | 3 | Prefer trains arriving at least this early when one fits |
| Walk instead if under (`maxWalkMin`) | 20 | Walking threshold (door to door) |
| Heads-up (`headsUpMin`) | 90 | Minutes before leave time |
| Second warning (`warningMin`) | 15 | Minutes before leave time |
| Quiet heads-ups (`quietStartHour`–`quietEndHour`) | 10 PM–7 AM | Heads-ups arrive silently in this window. Warnings and "leave now" always make sound. |
| Plan from previous event (`chainEvents`, `chainGapMin`) | on, 90 min | See §4.3 |
| Subway only (`subwayOnly`) | on | Ignore routes with buses/ferries unless nothing else works |
| MTA alerts (`checkAlerts`) | on | Use delay alerts |
| Include multi-day events (`includeMultiDay`) | off | On: plan for timed events spanning several days (e.g. a conference) at their start time. All-day events are ignored either way because they have no start time. |
| Show event details (`showEventDetails`) | on | Off: notifications say "your event" and leave out names and places |
| Calendars (`calendarIds`) | main calendar | The app lists all my calendars as checkboxes |
| Open directions in (`directionsApp`) | Google Maps | `google` or `citymapper`; anything else becomes `google` |
| `appUrl` (auto) | — | The app reports its own link. It's the `sub` of push signatures and where notifications open. |

**Trip settings vs. the rest.** Only these change which train I take: `homeAddress, walkToStationMin, minEarlyMin, maxEarlyMin, comfortMin, maxWalkMin, chainEvents, chainGapMin, subwayOnly, checkAlerts, includeMultiDay, calendarIds`. Each plan stores `settingsKey`, a hash of them. Changing any other setting (heads-up and warning minutes, quiet hours, show event details, directions app) never re-asks Google Maps.

Secrets and state in Script Properties (private to my Google account):
- `API_KEY`: used by the app. Created by `setup()`.
- `VAPID_PRIVATE` / `VAPID_PUBLIC`: the push signing key pair (base64url). Created by `setup()` if missing. Only the public key is ever sent anywhere.
- `PUSH_DEVICES`: `[{endpoint, addedAt}]`, at most 5; the oldest is dropped first. Only the push address is kept; empty pushes don't need the browser's encryption keys.
- **Upgrade from v2.2:** `setup()` and the first `tick()` on the new version delete the old notification topic and `WEB_APP_URL` properties.

## 4. Backend behavior

### 4.1 Which events count

The backend looks at events from now until the end of today (and always at least 8 hours ahead), across the chosen calendars. It skips an event if any of these apply:

- It is all-day. This is always the case, since there's no start time to plan for.
- It is **multi-day**, unless that setting is on. Multi-day means timed, lasting more than 12 hours, and ending on a later date, so a 10pm–1am dinner still counts as normal.
- It has no location, or an online location (links, Zoom, Meet, Teams, "virtual", "phone call").
- I declined it.
- Its type is working-location, out-of-office, focus-time, or birthday.

Tentative events count. Duplicates across calendars are merged.

### 4.2 Finding the place

The location is geocoded with Google Maps, biased to NYC, and the result is cached for 6 hours.

- **Not in NYC:** shown as "Not in NYC — no alerts", with no notifications. An event counts as NYC when the state is NY and one of these is true:
  - it's in one of the five boroughs or their counties, or
  - the city is "New York" and the point is inside the NYC bounding box.
- **Too vague** (the result is just a city, borough, zip, or state, e.g. "Brooklyn"): status `vague`.
- **Not found:** status `not_found`.

### 4.3 Where I'm coming from

- **From my previous event:** used when an earlier located event (not skipped, not multi-day) ends **within 90 min before** this one starts and doesn't overlap it. The trip starts at that event's address with no walk-to-station, and I can't leave before it ends.
- **From home:** used otherwise. The trip starts at `homeAddress`, plus `walkToStationMin`.

### 4.4 Planning a trip

1. Ask Google Maps for transit directions (with alternatives) arriving by the start time, and again arriving 6 min earlier. Merge the results and drop duplicates.
2. Turn each route into an option:
   - leave time = first departure − walk to station
   - arrival time and minutes early
   - legs: line, color, board/exit stops, times, stop count
3. Drop options I can't catch, meaning the leave time has already passed or falls before my previous event ends.
4. **Subway only:** keep only all-subway options. If none exist, keep them all and label them "includes bus/ferry".
5. **Window:** keep options arriving 0–10 min early. If none do, keep the 2 closest earlier ones and label them "closest available".
6. **Alerts:** attach active MTA alerts on each option's lines. An alert counts as a **delay** if its type or text mentions delays, suspensions, no service, slower service, or trains running express or bypassing stops. Planned stop changes and similar aren't delays.
7. **Recommendation:** out of the latest-leaving options, pick the first match in this order:
   1. no delays, arriving ≥ 3 min early
   2. no delays
   3. ≥ 3 min early
   4. anything

   If the pick is delayed, move its leave time 5 min earlier and say why.
8. **Walking:** ask for walking directions; door-to-door = walk + walk to station.
   - Recommend walking if it's ≤ 20 min **and** no more than 10 min slower than the recommended train door to door **and** still possible in time.
   - When walking, aim to arrive 5 min early.
   - The train options stay listed as alternatives.
9. If nothing works, the status is `no_route`.

**How often it re-asks Google Maps (keeps usage low):**
- right away if a trip setting changed (the plan's `settingsKey` differs, §3)
- more than 3 h before leaving: every 60 min
- closer than that: every 15 min
- right away if where I'm coming from changes
- never after "leave now" has been sent
- never again for not-NYC, vague, or not-found places, unless the event's location is edited (the location is part of the event's key)

### 4.5 Notifications

**Timing.** Minutes until the recommended leave time decide what goes out:

| Minutes until leaving | Notification | Push `Urgency` | Push `TTL` |
|---|---|---|---|
| ≤ 4 | **Leave now** (stays on screen until dismissed) | high | 600 s |
| ≤ warning + 2 | **Warning** ("Leave in N min") | high | 1800 s |
| ≤ heads-up | **Heads-up** (silent in quiet hours) | normal | 1800 s |

- Each stage is sent once. If several are due at once (e.g. an event added late), only the most urgent goes out.
- After the leave time has been missed by 10 minutes, nothing more is sent.

**Other messages:**
- **Change** (urgency high): sent after the heads-up or warning if the leave time has moved by 5 min or more and it's still more than 4 min away. At most 2 per event.
- **Can't plan** (urgency normal, silent in quiet hours): sent once when the event is within heads-up + 60 min. It says what to fix, e.g. "Add a street address to the event and it will update within 5 minutes."
- **Skipped events** get nothing.

**How a message is sent** (`notify_`):
1. Add it to the **outbox** (kept in the chunked store): `{id, createdAt, title, body, planKey, urgency, silent, kind, stage}`.
   - `id` always increases (a timestamp × 1000, plus a counter).
   - `kind` is `trip`, `problem`, `change` or `test`.
   - At most 30 messages, none older than 24 h.
2. **Ring** every registered device: an empty POST to its push address with headers `TTL`, `Urgency`, and `Authorization: vapid t=<JWT>, k=<VAPID_PUBLIC>`.
3. Read each reply:
   - `200`/`201`/`202`: accepted.
   - `404`/`410`: the phone unsubscribed or reinstalled; forget that device.
   - `400`/`403`: logged (usually a key mismatch; tapping **Enable notifications** again fixes it).
   - `429`/`5xx`/network error: kept; the next run retries.

**A stage counts as sent** when at least one device accepted, **or** no device is registered. In the second case the backend sets `pushWarning = 'no_device'` and the app shows a banner, so notifications don't pile up. If devices exist but none accepted, the message is taken back out of the outbox and the stage is retried on the next run.

**Message text** is the same as before. **Show event details** off hides names and places in the outbox too.

**On the phone** (service worker):
- On a push, it fetches `inbox?since=<last id>` (8 s timeout) and shows each message. The notification's tag is the event, so a Change replaces the heads-up.
- If the fetch fails or returns nothing, it shows "Leave By — time to check your trips" (Chrome requires a visible notification for every push).
- **Buttons:** **Open** (focuses or opens the app) and, for trip and change messages, **Skip this event** (calls `skip` with the API key).
- If the browser replaces the subscription, the service worker re-subscribes with the saved public key and registers the new address.

**Examples:**
- **Heads-up:**
  > **Leave 6:15 PM → Dinner w/ Sam**
  > 7:00 PM @ Carbone
  > A 6:22 PM from Canal St → Spring St, arrive 6:53 PM (7 min early)
  > Or: C 6:27 PM (arr 6:58 PM)
- **Warning:**
  > **Leave in 15 min (6:15 PM)**
  > Dinner w/ Sam at 7:00 PM · A 6:22 PM from Canal St → …
- **Leave now:**
  > **Leave now! Dinner w/ Sam**
  > A 6:22 PM from Canal St → Spring St …
- **Coming from another event:** "From Work lunch · …" is added.
- **Delays:**
  > ⏱ Leaving 5 min early because of delays.
  > ⚠️ A: Northbound A trains are running with delays

### 4.6 Web API

Every request needs `key` (compared in constant time with `safeEqual_`). All responses are JSON.

**GET requests:**

| `action` | What it does |
|---|---|
| `plans` (default) | `{version, needsHome, updatedAt, origin, walkToStationMin, settings, pushDevices, pushWarning, plans:[{key,title,location,address,start,status,message,options,alerts,originLabel,fromHome,skipped,sent,origin,dest}]}` |
| `refresh` | Re-plan everything now (⟳), then the same as `plans` |
| `update` | Normal run (`runPlanner_(false)`): only plans that need it are re-planned. Used right after saving settings. |
| `settings` | `{version, settings, defaults, calendars:[{id,name,primary}], pushPublicKey, pushDevices}` |
| `ping` | `{ok, version, now, hasTimer, lastRunAt, pushDevices, pushPublicKey}` |
| `inbox` | Takes `since`. Messages with a larger `id` from the last 6 h: the newest 5, oldest first. `{messages, lastId}` |
| `test` | Send a test notification. `{ok, accepted, devices, statuses}` |
| `skip` / `unskip` | Takes `id`. Skip or un-skip one event. |

An optional `app` parameter lets the app report its own link. It's stored only if it's an `https:` link.

**POST** (text/plain JSON body `{key, action, …}`):
- `saveSettings` `{settings}`: merge and save **only** (no re-planning, so it answers quickly). Returns `{ok, settings}`.
- `subscribe` `{endpoint}`: accepts only `https:` addresses on `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com` or `web.push.apple.com`. Returns `{ok, devices, lastId}`.
- `unsubscribe` `{endpoint}`: removes that device. Returns `{ok, devices}`.

### 4.7 Storage

Script Properties allow about 9 KB per value, so plans and the outbox are saved in chunks (`STORE_0…n`, with the count in `STORE_N`). Skips are kept while the event is still on today's list. Geocodes (address, NYC check, coordinates) use the script cache for 6 hours.

### 4.8 Web push signing

The "Web push signing" section of `Code.gs` implements ES256 in plain JavaScript with `BigInt` and no libraries:
- P-256 field and scalar arithmetic, Jacobian point add/double, scalar multiplication, modular inverse.
- `ecdsaSignP256_(hash, d)` uses **RFC 6979** deterministic `k` (HMAC-SHA256 from `Utilities`), so no random numbers are needed, and returns raw `r‖s` (64 bytes).
- Apps Script's byte functions use *signed* bytes; the code converts both ways.
- **Keys:** `setup()` makes `VAPID_PRIVATE` from an HMAC of fresh UUIDs, reduced into `[1, n−1]`, and `VAPID_PUBLIC` = `0x04‖X‖Y`.
- **JWT:** header `{"typ":"JWT","alg":"ES256"}`; claims `aud` (the push service's origin), `exp` (now + 12 h) and `sub` (the app's `https:` link — never an email address).
- The signed JWT is cached per `aud` for **6 hours** (the longest Apps Script's cache keeps anything; the spec asked for 11 h, which Apps Script doesn't allow). Signing is still rare.
- **`checkPush()`** (run from the editor) checks `BigInt`, creates keys if missing, signs and verifies a test JWT, logs "✅ Push signing works" and the number of registered devices.
- `resetSecrets()` makes a new API key and new push keys, and forgets all devices.

## 5. The app

**Today screen:** one card per event, in time order.
- Each card shows:
  - a bold **start time** (e.g. **7:00 PM**; "Tue 7:00 PM" if it isn't today) before the title, and a **Skip** link
  - the place, on its own line
  - **LEAVE BY 6:15 PM** (big) and **STARTS 7:00 PM** side by side, with "From home" or "From Work lunch (after it ends)" under them
  - a countdown that is green, turns orange at ≤ 15 min, red at ≤ 5, and reads "Leave now" at 0
- **Options:** the recommended one is outlined. Each shows MTA-colored line bullets, stops, times, and minutes early.
  - Delayed lines get "⚠️ delays".
  - When the backend added a delay buffer, the option says "⏱ Leave 5 min early — delays on this line".
  - Alert text appears under the card.
  - **Tapping an option** opens directions (a "Directions ›" hint shows this). Skip and Undo don't.
    - **Google Maps:** `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=transit` (`walking` for the walk option). Maps links can't carry a time, so Maps shows trips leaving now.
    - **Citymapper:** `https://citymapper.com/directions?startcoord=…&startname=…&startaddress=…&endcoord=…&endname=<title>&endaddress=…&arrival_time=<ISO 8601 with New York's offset>`. Without destination coordinates it falls back to Google Maps.
    - Every value is URL-encoded. The link builders live in `web/links.js`.
- **Gray cards** (with the start time too):
  - Skipped (with **Undo**)
  - Not in NYC
  - No home set ("Set where you leave from in ⚙︎ Settings")
  - Location too general / not found ("add a street address in Calendar")
  - No route (check Google Maps)
- **Header:** "Updated 6:05 PM", ⟳ (re-plan now, "Checking trains…"), and an **Install** chip when Chrome offers to install.
- **Banners** (all that apply, in this order):
  - **Can't reach the script** (red): e.g. "Can't reach your Google script (HTTP 404). Showing saved plans from 3:05 PM." Most failures show as "(no response)", because the browser hides the status of a blocked reply. A **How to fix** toggle explains, in plain words:
    - HTTP 404 or no response: the link is out of date, the deployment was archived, or it's a `/dev` test link → copy the **Web app** URL ending in `/exec` from **Deploy → Manage deployments** into ⚙︎ → Connection.
    - A web page instead of data: **Who has access** must be **Anyone**.
    - Wrong API key: reopen the setup link from `getAppLink`.
  - **Offline:** "You're offline. Showing saved plans from …".
  - No home set: "enter where you usually leave from".
  - Script out of date: the versions differ, so "paste the latest Code.gs…".
  - **Stale:** if the backend hasn't run for 20+ min: "notifications may have stopped — run setup again". Shown even when there's also an error.
  - **Notifications off:** `pushWarning` is `no_device`, or this phone hasn't allowed notifications: "🔔 Notifications are off on this phone — tap to turn on." Tapping opens ⚙︎ → This phone.
- **Refreshing:** the app reloads when opened, every 5 min while open, and when ⟳ is tapped.

**Settings (⚙︎):**
- **This phone:**
  - **App:** Installed ✓ (detected with `display-mode: standalone`), or an **Install app** button when Chrome offers it. If Chrome never offers it (it thinks the app is installed), the app explains: look in the app drawer; if it won't open, uninstall it in Android Settings → Apps → Leave By and reinstall from Chrome's ⋮ menu → Add to Home screen.
  - **Notifications:** On ✓ / Off [**Enable notifications**] / Blocked ("Allow notifications for Leave By in Android Settings → Apps → Leave By → Notifications").
    - **Enable notifications** asks permission, subscribes with the script's public key (from `ping`), and POSTs `subscribe`. If the app isn't installed: "Install the app first, then enable notifications here."
    - Every time the app opens with permission granted and a subscription, it re-POSTs `subscribe` to keep the device list fresh.
  - **Send test notification:** "Sent to N device(s) — it should pop up in a few seconds", or "No device registered — tap Enable notifications first", or the problem in plain words.
- **Your trips:** leaving from, walk time, walk threshold, arrival window, checkboxes for previous event / subway only / MTA alerts / multi-day, and "Open directions in [Google Maps ▾]".
- **Notifications:** heads-up and warning minutes, quiet hours, show event details.
- **Calendars to watch:** checkboxes, and a small **Refresh list** link.
- **Connection** (collapsed): web app URL and key.
  - A one-tap link `…/#api=<url>&key=<key>` fills these in (a `#key=<key>` link fills in just the key).
  - The URL is checked against `https://script.google.com/macros/s/<id>/exec`. A `/dev` link gets "This is a test link — it only works when you're signed in on a computer. Use the /exec link." and isn't used.
  - **Check connection** calls `ping` and lists: script reachable ✓/✗, key accepted ✓/✗, version (and whether it matches the app), background timer ✓/✗ with the last check time, and devices registered.
- **Fast opening:** the `plans` response includes `settings`, and the app caches settings and the calendar list on the phone. ⚙︎ opens instantly with the cached values, ready to edit. The calendar list reloads in the background only when the cache is over 24 h old or I tap **Refresh list**. The very first time, it loads once.
- **Save:** the button shows "Saving…"; the backend only saves. On success the sheet closes at once and the app calls `update` in the background ("Updating trips…", ⟳ spins). On error the sheet stays open with the message. The Save/Close bar stays visible at the bottom.

**Offline:** the service worker caches the app files, and the last plans are kept on the phone. When offline, the app shows them with an "Offline" label.

**Connection for the service worker:** the service worker can't read `localStorage`, so the app also keeps `{url, key}` in IndexedDB (database `leave-by`, store `kv`), along with `lastInboxId` and the push public key.

**Look and feel:** installable (manifest with a stable `"id": "/train-time/"`, `start_url` and `scope` `"./"`, 192/512 px and maskable icons), dark theme, and `?demo` shows sample data.

## 6. Setup, deployment and working with Claude Code

1. **Claude Code, first time:**
   1. Create the **public** repo (free GitHub Pages needs a public repo, so it contains no personal data; see §7).
   2. Set `DEFAULTS.appUrl` to the Pages link.
   3. Push to `main` and turn on Pages via GitHub Actions.
2. **Me** (README has phone-friendly steps):
   1. Paste `Code.gs` and `appsscript.json` into a new Apps Script project.
   2. Run `setup` and approve read-only calendar access. This also creates the push keys.
   3. Deploy as a web app (Me / Anyone).
   4. Run `getAppLink`. If Google only gives the `/dev` test link, it logs a warning, a key-only link, and asks me to paste the `/exec` Web app URL from **Deploy → Manage deployments** into ⚙︎ → Connection.
   5. Open the link and install the app.
   6. Open it from its icon → ⚙︎ → set **Leaving from** → **Enable notifications** → **Send test notification**.
3. **Later changes:**
   1. Claude Code works on a branch and opens a PR.
   2. The **Tests** workflow runs on it.
   3. The PR template tells me in plain English whether I need to do anything.
   4. Merging to `main` redeploys the app.
4. **Keeping the script in step.** `VERSION` in Code.gs must equal `EXPECTED_BACKEND_VERSION` in `web/app.js` (a test enforces this). When they differ, the app shows a banner asking me to paste the new Code.gs and deploy a new version.
5. **Repo support files:**
   - `CLAUDE.md`: rules for Claude Code
   - `.claude/settings.json`: pre-approved safe commands
   - `.github/pull_request_template.md`
   - `.github/workflows/test.yml` (PRs) and `pages.yml` (deploy, runs tests first)
   - `.github/dependabot.yml`: keeps Actions up to date

## 7. Privacy

| Concern | What we do |
|---|---|
| The repo is public | No personal data in code, docs, demos or tests: no home station, names, keys, device addresses, web app link or emails. Personal settings live in Script Properties, which is private to my Google account. A test scans public files for links, device addresses and emails. |
| Google permissions | The script asks only for **read-only** calendar access, the ability to call outside websites (Maps, MTA, push services), and the ability to create its own timer (`appsscript.json` → `oauthScopes`). It can't change or delete events. |
| Who could see my calendar? | Only someone with the app's key, which is stored only on my phone (and in the one-tap setup link), can call the script. Even then they'd see only today's located events that the app plans, not the whole calendar, and couldn't change anything, because access is read-only. The key is compared in constant time. **Don't share the setup link**; `resetSecrets()` makes a new key if it leaks. |
| Notifications | The push service (Google's, for Chrome on Android) only receives an empty signal and never sees event details. The message text travels straight from my script to my phone over HTTPS. The push signing key and device addresses live only in Script Properties. The JWT `sub` is the app's link, not an email. |
| Lock screen | Notifications show there like any app's. Use Android's lock-screen settings, or turn off **Show event names & places**. |
| Directions | Tapping an option sends the start and end addresses (possibly my home) to Google Maps or Citymapper — only when I tap. |
| Location data | Event locations go to Google Maps (already Google's data). Nothing personal is sent to the MTA feed. |
| The Apps Script project | Keep it unshared: anyone with edit access could read Script Properties. |
| Git history | Commits should use a GitHub no-reply email: turn on GitHub → Settings → Emails → *Keep my email addresses private*. |

## 8. Testing

`node tests/run.js` runs the backend in Node with fake Google services (the fakes use signed bytes, like Apps Script). GitHub runs it on every PR and before every deploy. The tests cover:

- NYC and vague-place detection, and event filtering
- The arrival window, buffer preference, delay avoidance and delay buffer, and walk-vs-train
- Planning from the previous event, including when that event is skipped
- Notification stages, late additions, change notices, "can't plan", quiet hours (silent), and hidden event details (also in the outbox)
- **Push signing:** the public key and JWT signature match Node's `crypto`; the RFC 6979 A.2.5 test vector gives the published `r` and `s`; JWT claims and caching
- **Doorbells:** outbox messages, push headers (`Authorization`, `TTL`, `Urgency`), removing gone devices, the no-device warning, retries, `inbox`, `subscribe` / `unsubscribe`, `test`, and the upgrade that deletes old properties
- **Speed:** saving settings makes no Maps calls; notification-only changes re-plan nothing; trip changes re-plan
- **Directions:** plans carry origin/destination coordinates; Google Maps and Citymapper links (encoding, walking, fallback, New York offset in summer and winter)
- How often Google Maps is re-asked, chunked storage, settings validation, API auth (constant-time), `ping`, and `getAppLink`
- Multi-day events: ignored, included, and never used as a starting point
- The "no home set" state, app/script versions matching, no secrets in public files, and no mention of the old notification service in any tracked file

## 9. Future ideas

- Live train arrivals (MTA real-time feeds)
- Weather-aware walking
- A morning summary ("2 trips today")
- Work/office as a second home base
