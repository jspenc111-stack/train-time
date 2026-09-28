# Leave By — Spec (v2.2)

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
- The app shows today's plan. All settings are editable in the app, with no code editing needed.

**Out of scope:** events outside NYC (shown but silent), live "train arrives in 3 min" countdowns, and weather.

## 2. How it fits together

```
Google Calendar ──► Google Apps Script (my account, runs every 5 min, free)
                     ├─ Google Maps: find places + subway/walking directions (no API key needed)
                     ├─ MTA subway alerts feed (best effort)
                     ├─ ntfy.sh ──► ntfy app on my Pixel (notifications + Skip button)
                     └─ Web API ◄──► Leave By app (PWA on GitHub Pages): plans, settings, skip
```

- **Backend** (`apps-script/Code.gs`): Google Apps Script. It reads my calendar directly and uses Apps Script's built-in Maps service, so there is no Google Cloud project, API key, or billing.
- **Notifications:** the backend posts to a secret ntfy topic, and the ntfy app shows the alert.
  - Tapping the notification opens the app.
  - The notification's **Skip** button calls the backend directly. It carries a per-event code, not the API key.
- **App** (`web/`): a static PWA, deployed to GitHub Pages by a GitHub Actions workflow on every push to `main`.

**Why ntfy instead of PWA push:** Android won't let a PWA run on a schedule, and Web Push from Apps Script would need encryption that Apps Script can't do. I chose ntfy for reliability.

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
| `appUrl` (auto) | — | The app reports its own link, so notifications can open it |

Secrets, created by `setup()`:
- `API_KEY`: used by the app.
- `NTFY_TOPIC`: a random topic name.
- `WEB_APP_URL`: the backend's own link (the one ending in `/exec`). It is saved by `getAppLink()`, and the app also reports it. Links ending in `/dev` are never saved: they are Google's test links and only work inside the script editor.

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
- more than 3 h before leaving: every 60 min
- closer than that: every 15 min
- right away if where I'm coming from changes
- never after "leave now" has been sent
- never again for not-NYC, vague, or not-found places, unless the event's location is edited (the location is part of the event's key)

### 4.5 Notifications

**Timing.** Minutes until the recommended leave time decide what goes out:

| Minutes until leaving | Notification | Priority |
|---|---|---|
| ≤ 4 | **Leave now** | 5 (urgent) |
| ≤ warning + 2 | **Warning** ("Leave in N min") | 4 |
| ≤ heads-up | **Heads-up** | 3, or 2 (silent) in quiet hours |

- Each stage is sent once. If several are due at once (e.g. an event added late), only the most urgent goes out.
- After the leave time has been missed by 10 minutes, nothing more is sent.

**Other messages:**
- **Change:** sent after the heads-up or warning if the leave time has moved by 5 min or more and it's still more than 4 min away. At most 2 per event.
- **Can't plan:** sent once when the event is within heads-up + 60 min. It says what to fix, e.g. "Add a street address to the event and it will update within 5 minutes."
- **Skipped events** get nothing.

**Buttons:**
- **Open:** opens the app.
- **Skip this event:** `?action=skip&id=…&t=<code>`, where the code is an HMAC of the event key made with the API key.

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

Every request needs `key`, except a Skip carrying a valid per-event code. All responses are JSON.

**GET requests:**

| `action` | What it does |
|---|---|
| `plans` (default) | `{version, needsHome, updatedAt, origin, ntfyTopic, plans:[{key,title,location,start,status,message,options,alerts,originLabel,fromHome,skipped,sent}]}` |
| `refresh` | Re-plan everything now, then the same as `plans` |
| `settings` | `{settings, defaults, calendars:[{id,name,primary}], ntfyTopic}` |
| `test` | Send a test notification |
| `skip` / `unskip` | Takes `id`. Skip or un-skip one event. |

Optional `self` and `app` parameters let the app report its own links. They're stored only if they look valid.

**POST** (text/plain JSON body `{key, action:'saveSettings', settings}`): merge the settings, re-plan, and return the `settings` view plus `plans`.

### 4.7 Storage

Script Properties allow about 9 KB per value, so plans are saved in chunks (`STORE_0…n`, with the count in `STORE_N`). Skips are kept while the event is still on today's list. Geocodes use the script cache.

## 5. The app

**Today screen:** one card per event, in time order.
- Each card shows:
  - the title, time, place, and a **Skip** link
  - a big **Leave by** time, with "From home" or "From Work lunch (after it ends)" under it
  - a countdown that is green, turns orange at ≤ 15 min, red at ≤ 5, and reads "Leave now" at 0
- **Options:** the recommended one is outlined. Each shows MTA-colored line bullets, stops, times, and minutes early.
  - Delayed lines get "⚠️ delays".
  - When the backend added a delay buffer, the option says "⏱ Leave 5 min early — delays on this line".
  - Alert text appears under the card.
- **Gray cards:**
  - Skipped (with **Undo**)
  - Not in NYC
  - No home set ("Set where you leave from in ⚙︎ Settings")
  - Location too general / not found ("add a street address in Calendar")
  - No route (check Google Maps)
- **Header:** "Updated 6:05 PM" and ⟳ (re-plan now).
- **Banners** (one at a time, in this order):
  - No home set: "enter where you usually leave from".
  - Script out of date: the versions differ, so "paste the latest Code.gs…".
  - **Stale:** if the backend hasn't run for 20+ min: "notifications may have stopped — run setup again".
- **Refreshing:** the app reloads when opened, every 5 min while open, and when ⟳ is tapped.

**Settings (⚙︎):**
- **Your trips:** leaving from, walk time, walk threshold, arrival window, and checkboxes for previous event / subway only / MTA alerts.
- **Notifications:** heads-up and warning minutes, quiet hours, show event details, the ntfy topic, and a test button.
- **Calendars to watch:** checkboxes.
- **Connection** (collapsed): web app URL and key. A one-tap link `…/#api=<url>&key=<key>` fills these in (a `#key=<key>` link fills in just the key). A `/dev` URL is refused with a message saying to copy the `/exec` Web app URL from **Deploy → Manage deployments**. If the script can't be reached at all, the app says to check the deployment is **Execute as: Me** / **Who has access: Anyone**.
- **Save:** re-plans and closes the sheet. The Save/Close bar stays visible at the bottom.

**Offline:** the service worker caches the app files, and the last plans are kept on the phone. When offline, the app shows them with an "Offline" label.

**Look and feel:** installable (manifest, 192/512 px and maskable icons), dark theme, and `?demo` shows sample data.

## 6. Setup, deployment and working with Claude Code

1. **Claude Code, first time:**
   1. Create the **public** repo (free GitHub Pages needs a public repo, so it contains no personal data; see §7).
   2. Set `DEFAULTS.appUrl` to the Pages link.
   3. Push to `main` and turn on Pages via GitHub Actions.
2. **Me** (README has phone-friendly steps):
   1. Paste `Code.gs` and `appsscript.json` into a new Apps Script project.
   2. Run `setup` and approve read-only calendar access.
   3. Deploy as a web app (Me / Anyone).
   4. Run `getAppLink`. When run from the editor, Google may only give the `/dev` test link; then `getAppLink` uses the `/exec` link the app reported earlier, or else logs a key-only link and asks me to paste the `/exec` Web app URL from **Deploy → Manage deployments** into ⚙︎ → Connection.
   5. Subscribe to the topic in ntfy.
   6. Open the link and install the app.
   7. Set **Leaving from** in ⚙︎.
   8. Tap **Send test notification**.
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
| The repo is public | No personal data in code, docs, demos or tests: no home station, no names, keys, topic, web app link or emails. Personal settings live in Script Properties, which is private to my Google account. A test scans public files for keys, topics, links and emails. |
| Google permissions | The script asks only for **read-only** calendar access, the ability to call outside websites (Maps, MTA, ntfy), and the ability to create its own timer (`appsscript.json` → `oauthScopes`). It can't change or delete events. |
| The backend link is open to "Anyone" | Every request needs the API key; the link is useless without it. The key sits only in my phone's app storage and the one-tap setup link. **Don't share that link.** `resetSecrets()` makes a new key and topic if either leaks. |
| Notifications go via ntfy.sh (a public relay) | They pass through ntfy's servers (kept about 12 hours). Anyone who knows the topic name could read them, so the topic is random. A **Show event details** setting (off) hides event names and places. The Skip button uses a per-event code, never the API key. |
| Location data | Event locations go to Google Maps (already Google's data). Nothing personal is sent to the MTA feed. |
| Git history | Commits should use a GitHub no-reply email: turn on GitHub → Settings → Emails → *Keep my email addresses private*. |

## 8. Testing

`node tests/run.js` runs the backend in Node with fake Google services (26 tests). GitHub runs it on every PR and before every deploy. The tests cover:

- NYC and vague-place detection, and event filtering
- The arrival window, buffer preference, delay avoidance and delay buffer, and walk-vs-train
- Planning from the previous event, including when that event is skipped
- Notification stages, late additions, change notices, "can't plan", and quiet hours
- How often Google Maps is re-asked, chunked storage, settings validation, API auth, and Skip codes
- Multi-day events: ignored, included, and never used as a starting point
- The "no home set" state, hidden event details, app/script versions matching, and no secrets in public files

## 9. Future ideas

- Live train arrivals (MTA real-time feeds)
- Weather-aware walking
- A morning summary ("2 trips today")
- Work/office as a second home base
