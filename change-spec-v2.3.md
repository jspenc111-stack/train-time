# Leave By: change spec v2.3

Implement everything below in this repo. Follow `CLAUDE.md`:
- work on a branch and open a PR;
- tests first;
- keep SPEC.md and README in sync;
- bump `VERSION` in `apps-script/Code.gs` and `EXPECTED_BACKEND_VERSION` in `web/app.js` to **2.3.0**, and bump `CACHE` in `web/sw.js`.

The owner is not a developer, so write the PR description in plain English. It must start with:

> ⚠️ After merging: paste the new Code.gs into script.google.com, save, run **setup** once, then Deploy → Manage deployments → ✏️ → Version: New version → Deploy. Then open the app from its home-screen icon → ⚙︎ → **Enable notifications** → **Send test notification**.

Suggested order: §1 remove ntfy → §2 push signing and its tests → §3 doorbell notifications → §4 install → §5 settings speed → §6 start time → §7 directions → §8 connection errors → §9 privacy and docs.

---

## 1. Remove ntfy completely

The free ntfy.sh service limits messages per internet address. Apps Script calls come from Google's shared addresses, so the daily quota is used up by strangers ("daily message quota reached"). We replace ntfy with web push to the installed app (§2–§3).

**Code.gs:**
- Delete `sendNtfy_`, `FIXED.NTFY_SERVER`, all ntfy payload building (ntfy `tags` and `actions`), the ntfy topic creation in `setup()`, and `ntfyTopic` everywhere.
- Delete `skipToken_`, the `t=` Skip-code path in `doGet`, `WEB_APP_URL`, and the `self` query parameter. Skip now happens from the app with the key (§3).
- `resetSecrets()` now regenerates the API key and the push keys, and clears push devices (§2).
- **Migration:** `setup()` and the first `tick()` on the new version delete the Script Properties `NTFY_TOPIC` and `WEB_APP_URL` if they exist.

**App:** remove the ntfy topic hint and every ntfy wording.

**Docs and tests:** remove ntfy from README, SPEC.md, CLAUDE.md, the PR template and the tests.
- Update the "no personal details in public files" test: drop the ntfy-topic pattern.
- Add a test that `git ls-files` content contains no `ntfy` (case-insensitive).
- Acceptance: `grep -ri ntfy .` returns nothing outside `.git`.

## 2. Push signing in Apps Script (VAPID, ES256)

Web push needs the sender to sign a short token (a JWT) with an ECDSA P-256 key. Apps Script has no built-in ECDSA, so implement it in plain JavaScript inside `Code.gs`, in a clearly marked section called "Web push signing". Use `BigInt` and no libraries.

**P-256 math:**
- Field and scalar arithmetic.
- Point add and double in Jacobian coordinates.
- Scalar multiplication.
- Modular inverse.

**`ecdsaSignP256_(hashBytes, dBigInt)`:**
- Use **RFC 6979 deterministic k**, built with HMAC-SHA256 from `Utilities.computeHmacSha256Signature(byte[], byte[])`, so no random numbers are needed.
- Return raw `r‖s` (64 bytes, JOSE format).
- SHA-256 comes from `Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)`.
- Apps Script returns *signed* bytes, so normalize with `& 0xff` everywhere.

**Keys:**
- `setup()` creates the keys if they're missing:
  - `VAPID_PRIVATE`: 32 bytes. Build them from `computeHmacSha256Signature(Utilities.getUuid() + Date.now(), Utilities.getUuid())`, then reduce into `[1, n−1]`.
  - `VAPID_PUBLIC`: the uncompressed point `0x04‖X‖Y` (65 bytes).
  - Store both base64url-encoded in Script Properties. They must never appear in code or responses, except `VAPID_PUBLIC`.

**JWT:**
- Header: `{"typ":"JWT","alg":"ES256"}`.
- Claims:
  - `aud`: the push endpoint's origin, e.g. `https://fcm.googleapis.com`.
  - `exp`: now + 12 h.
  - `sub`: the app's URL (`settings.appUrl`, an `https:` URL). **Never an email address.**
- Cache the signed JWT per `aud` in `CacheService` for 11 h, so signing happens rarely.

**Self-check:** add a public function `checkPush()` that the owner can run from the editor. It should:
1. Confirm `BigInt` works.
2. Create the keys if missing.
3. Sign a test JWT and verify it with its own verify function.
4. Log "✅ Push signing works" and how many devices are registered.

**Tests (Node):**
- The public key derived from `d` equals Node's `crypto.createECDH('prime256v1')` public key for the same `d`.
- The JWT signature verifies with Node's `crypto.verify('sha256', …, {key, dsaEncoding: 'ieee-p1363'})`.
- The **RFC 6979 Appendix A.2.5** P-256/SHA-256 test vector (message "sample") gives the exact published `r` and `s`.
- Mocks: add `Utilities.computeDigest`, `Utilities.DigestAlgorithm`, the byte-array overload of `computeHmacSha256Signature`, `Utilities.base64EncodeWebSafe` and `Utilities.base64DecodeWebSafe`, all returning signed bytes like Apps Script.

## 3. Doorbell notifications

The script sends an **empty** web push (a "doorbell") through the phone's push service. The installed app wakes up, fetches the real message from the script, and shows it. Nothing readable passes through the push service.

### Backend

**Devices:**
- Script Property `PUSH_DEVICES`: a JSON array of `{endpoint, addedAt}`, at most 5 entries, oldest dropped first.
- Store only the endpoint. Payload-less push doesn't need the browser's encryption keys.

**Outbox:**
- Kept in the chunked store: a list of `{id, createdAt, title, body, planKey, urgency, silent, kind}`.
  - `id` is increasing (a timestamp plus a counter).
  - `kind` is `'trip' | 'problem' | 'change' | 'test'`.
- Keep at most 30 entries and drop anything older than 24 h.

**`notify_(msg, plan)`** replaces `sendNtfy_`:
1. Append the message to the outbox.
2. Ring every device: `UrlFetchApp.fetch(endpoint, {method:'post', payload:'', muteHttpExceptions:true, headers:{...}})` with these headers:
   - `TTL`: `600` for "leave now", `1800` for others.
   - `Urgency`: `high` for warning, leave now and change; `normal` for heads-up and problem.
   - `Authorization`: `vapid t=<jwt>, k=<VAPID_PUBLIC>`.
3. Read the response code:
   - `201`/`200`/`202`: the device accepted it.
   - `404`/`410`: remove that device.
   - `403`/`400`: log it (key problem).
   - `429`/`5xx`: leave it; the next tick retries.
4. Return `{accepted, devices, statuses}`.

**A stage counts as sent when:**
- at least one device accepted the doorbell, **or**
- there are no devices. In that case, set `store.pushWarning = 'no_device'` so the app can show a banner. Notifications don't pile up.

**Message text:**
- Same wording as today's notifications, minus ntfy emoji tags.
- Heads-ups during quiet hours set `silent: true`.
- `showEventDetails` still hides titles and places.

**API:**
- **GET `inbox`** (key required, `since=<id>`): returns `{messages:[…]}` newer than `since` from the last 6 h, oldest first, at most 5.
- **POST `subscribe`** `{key, endpoint}`:
  - Accept only `https:` endpoints on known push services: `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`.
  - Store the device and return `{ok, devices}`.
- **POST `unsubscribe`** `{key, endpoint}`: remove that device.
- **GET `test`**: calls `notify_` with a test message and returns `{ok, accepted, devices, statuses}`.
- **`ping`** (see §8) and **`settings`**: include `pushPublicKey` and `pushDevices` (a count).

**Apps Script gotcha:** web push endpoints need no special OAuth scope beyond `script.external_request`, which we already have.

### App

**Connection storage:** the service worker can't read `localStorage`, so `app.js` also writes `{url, key}` to IndexedDB (database `leave-by`, store `kv`) whenever the connection is saved, and once on load for existing users.

**Service worker (`sw.js`):**
- **`push` event:**
  1. Read the connection and `lastInboxId` from IndexedDB.
  2. Fetch `inbox?since=lastInboxId&key=…` with an 8 s timeout.
  3. Show each message with `registration.showNotification(title, {...})`:
     - `body`
     - `tag: planKey || id`, plus `renotify: true`
     - `icon` and `badge` from the app icons
     - `silent`
     - `requireInteraction: true` for "leave now"
     - `data: {planKey, kind}`
     - `actions: [{action:'open', title:'Open'}, {action:'skip', title:'Skip this event'}]`; include Skip only for trip or change messages.
  4. Save `lastInboxId`.
  5. If the fetch fails or returns nothing, show one fallback notification: "Leave By — time to check your trips". Chrome requires a visible notification for every push.
- **`notificationclick`:**
  - `skip`: GET `skip&id=<planKey>&key=…`, then close the notification.
  - Otherwise: focus an open app window, or `clients.openWindow(<app scope URL>)`.
- **`pushsubscriptionchange`:** re-subscribe with the saved public key and POST `subscribe`.

**⚙︎ → "This phone" section:**
- **Notifications:** On ✓ / Off [**Enable notifications**] / Blocked ("Allow notifications for Leave By in Android Settings → Apps → Leave By → Notifications").
- **Enable notifications** does three things:
  1. `Notification.requestPermission()`.
  2. `pushManager.subscribe({userVisibleOnly:true, applicationServerKey: <pushPublicKey as Uint8Array>})`.
  3. POST `subscribe`.
  - If the app isn't installed (see §4), say "Install the app first, then enable notifications here."
- **Send test notification:**
  - Success: "Sent to N device(s) — it should pop up in a few seconds."
  - No devices: "No device registered — tap Enable notifications first."
  - Otherwise: the error in plain words.
- **On every app open:** if permission is granted and a subscription exists, re-POST `subscribe`. It's cheap, and it keeps the device list fresh.

**Banners:**
- `pushWarning === 'no_device'`, or permission not granted on this phone: "🔔 Notifications are off on this phone — tap to turn on." Tapping opens ⚙︎ → This phone.

### Tests
- A notification stage adds an outbox message and POSTs to each device with the correct `Authorization`, `TTL` and `Urgency` headers.
- `410` removes a device.
- No devices sets `pushWarning`, and the stage is still marked sent.
- `inbox` returns only newer messages and prunes old ones.
- `subscribe` rejects unknown hosts and requires the key.
- The migration deletes `NTFY_TOPIC` and `WEB_APP_URL`.
- Quiet-hours heads-ups set `silent: true`.
- Hidden details stay hidden in outbox text.

## 4. Fix "already installed" but won't open

Chrome sometimes reports the app as installed while it can't be opened. Web push also only works in the installed app.

**`manifest.webmanifest`:**
- Add a stable `"id": "/<repo-name>/"` (this repo: `"/train-time/"`).
- Keep `start_url` and `scope` as `"./"`.

**App:**
- Detect installed mode with `matchMedia('(display-mode: standalone)')`. When installed, ⚙︎ → This phone shows **Installed ✓**.
- When not installed:
  - Listen for `beforeinstallprompt`, keep the event, and show an **Install app** button in ⚙︎ → This phone. Show a small header chip too.
  - If that event never fires (Chrome thinks it's installed), show: "Chrome says Leave By is installed. Look for it in your app drawer (swipe up) and add it to your home screen. If it won't open, uninstall it in Android Settings → Apps → Leave By, then reinstall from Chrome's ⋮ menu → Add to Home screen."

**README:** add the same text to Troubleshooting.

## 5. Make Settings fast

**What's slow now:**
- Opening ⚙︎ waits for `action=settings`, which wakes Apps Script and lists every calendar. The fields stay disabled until it answers.
- Saving re-plans every event with fresh Google Maps calls before replying (10–30 s).

**Changes:**
- The `plans` response also includes `settings`. The app caches settings and the calendar list in localStorage.
- **Opening ⚙︎:** show cached values instantly with the fields enabled.
  - The calendar list reloads in the background only if the cache is over 24 h old, or when the user taps a small "Refresh list" link.
  - First run with no cache: load once, as today.
- **Saving:** `doPost` for `saveSettings` saves only, with **no re-planning**. The button shows "Saving…".
  - On success, close the sheet at once.
  - On error, keep it open and show the message.
- **After a successful save:** the app calls a new GET action **`update`** in the background (`runPlanner_(false)`). Meanwhile the status line says "Updating trips…" and ⟳ spins.
- **Smarter re-planning:**
  - Each plan stores `settingsKey`: a hash of the trip-affecting settings (`homeAddress, walkToStationMin, minEarlyMin, maxEarlyMin, comfortMin, maxWalkMin, chainEvents, chainGapMin, subwayOnly, checkAlerts, includeMultiDay, calendarIds`).
  - `needsReplan_()` returns true when the key differs.
  - Display and notification settings (`headsUpMin, warningMin, quietStartHour, quietEndHour, showEventDetails, directionsApp`) never cause a re-plan.
- ⟳ still forces a full re-plan, with the status "Checking trains…".

**Tests:**
- `doPost` makes 0 Maps calls.
- Changing only notification settings then calling `update` makes 0 directions calls.
- Changing walk time then calling `update` re-plans.

## 6. Make the start time easy to see (app)

- **Card header:** a bold time chip before the title, e.g. **`7:00 PM`**: at least 18px, weight 700, full contrast. If the event isn't today, add the day (`Tue 7:00 PM`).
- **Line under the title:** the location only.
- **Leave-by block:** two times side by side, each labelled in the "LEAVE BY" style:
  - **LEAVE BY 6:15 PM** (big, as now)
  - **STARTS 7:00 PM** (about 24px)

  The countdown pill sits next to or under them, with no sideways scrolling at 360px width.
- **Grey cards** show the time chip too.
- Update the `?demo` data.

## 7. Tap an option for directions (Google Maps or Citymapper)

**Backend:**
- `geocode_()` also returns `lat` and `lng` (from `geometry.location`), kept in the cache.
- Plans include:
  - `dest: {address, lat, lng}`
  - `origin: {address, lat, lng, label}`

  The origin coordinates come from the cached geocode of the home address or the previous event's address. Add no new directions calls.

**Setting `directionsApp`:** `'google'` (default) or `'citymapper'`.
- Sanitize it to one of those.
- It appears in ⚙︎ → Your trips as "Open directions in [Google Maps ▾]".

**App:**
- Every option (recommended, alternatives, walk) is wrapped in `<a target="_blank" rel="noopener">`, with a small "Directions ›" hint and a pressed style.
- Skip and Undo must not open directions.
- **Google Maps link:**

  ```
  https://www.google.com/maps/dir/?api=1&origin=<origin.address>&destination=<dest.address>&travelmode=transit
  ```

  Use `walking` for the walk option. URL-encode every value. Maps links can't carry a time, so Maps shows trains leaving now.
- **Citymapper link:**

  ```
  https://citymapper.com/directions?startcoord=<lat>,<lng>&startname=<label>&startaddress=<origin.address>&endcoord=<lat>,<lng>&endname=<title>&endaddress=<dest.address>&arrival_time=<ISO-8601>
  ```

  `arrival_time` is the option's `arriveAt` with the New York offset, e.g. `2026-09-28T18:53:00-04:00`. If `dest` has no coordinates, fall back to Google Maps.
- Put the link builders in a new **`web/links.js`**:
  - It sets `window.LeaveByLinks = {googleMapsUrl, citymapperUrl, directionsUrl}` and also uses `module.exports` when available.
  - Load it before `app.js`, and add it to the service worker's `ASSETS`.

**Tests:**
- Plans include `origin` and `dest` with coordinates.
- The URLs are encoded correctly, including walking.
- The Citymapper link falls back to Google Maps without coordinates.
- The ISO offset is right in summer and winter.

## 8. Clear connection errors

Today, when the app can't reach the script, it quietly shows old saved plans with only small red text.

- **Error banner.** When the latest call failed, show a red banner:

  > Can't reach your Google script (HTTP 404). Showing saved plans from 3:05 PM.

  Add a "How to fix" toggle with plain-word causes:
  - **404:** the web app link is out of date, the deployment was archived, or it's a `/dev` test link. Go to Deploy → Manage deployments, copy the **Web app** URL ending in `/exec`, and paste it into ⚙︎ → Connection.
  - **A web page instead of data:** the deployment's **Who has access** must be **Anyone**.
  - **Wrong API key:** reopen the setup link from `getAppLink`.
- The stale-data banner (no background check for 20+ min) shows even when there's also an error.
- **Link check.** ⚙︎ → Connection validates the URL format `https://script.google.com/macros/s/<id>/exec`. For `/dev` links, warn: "This is a test link — it only works when you're signed in on a computer. Use the /exec link."
- **Check connection button** in ⚙︎ → Connection. It calls a new GET action **`ping`** (key required), which returns `{ok, version, now, hasTimer, lastRunAt, pushDevices}`. Show the results in plain words:
  - Script reachable ✓/✗
  - Key accepted ✓/✗
  - Version (and whether it matches the app)
  - Background timer running ✓/✗, plus the last check time
  - Devices registered for notifications
- **`getAppLink()`:** if the URL ends in `/dev`, log a clear warning to copy the `/exec` URL from Deploy → Manage deployments.

**Tests:** `ping` requires the key and reports `hasTimer` and `pushDevices`.

## 9. Privacy hardening and docs

- Compare the API key with a constant-time helper, `safeEqual_(a, b)`.
- **SPEC.md → Privacy:** rewrite without ntfy, and add these points:
  - **Who could see my calendar?** Only someone with the app's key, which is stored only on the phone, can call the script. Even then they'd see only today's located events the app plans, not the whole calendar, and couldn't change anything, because access is read-only.
  - **Notifications:**
    - The push service (Google's, for Chrome on Android) only receives an empty signal and never sees event details.
    - The message text travels straight from your script to the phone over HTTPS.
    - The push signing key and device addresses live only in Script Properties.
    - The JWT `sub` is the app's URL, not an email.
  - **Lock screen:** notifications show there like any app's. Use Android's lock-screen settings, or turn off "Show event names & places".
  - **Directions:** tapping an option sends the start and end addresses (possibly your home) to Google Maps or Citymapper, only when you tap.
  - Keep the Apps Script project unshared.
- **README:**
  - One-time setup:
    1. Paste Code.gs and run `setup`.
    2. Deploy as a web app, then run `getAppLink`.
    3. Open the link and install the app.
    4. Open it from its icon → ⚙︎ → set **Leaving from** → **Enable notifications** → **Send test notification**.
  - Troubleshooting:
    - No notifications: check Android Settings → Apps → Leave By → Notifications is allowed, run `checkPush` in the editor, and use "Check connection".
    - The "already installed" fix from §4.
  - Remove all ntfy steps.
- **CLAUDE.md:**
  - Add `checkPush` and the new actions to the public entry points.
  - Note that the push signing section must keep its RFC 6979 and Node-verification tests.

## Done means

- All old and new tests pass, and `grep -ri ntfy .` finds nothing outside `.git`.
- `?demo` works at 360px width and shows the new start-time layout, tappable options, and the "This phone" section.
- SPEC.md, README, CLAUDE.md and the PR checklist are updated, and the PR starts with the ⚠️ note above.
