# Leave By 🚇

Tells you **when to leave** and **which subway to take** for your Google Calendar events in NYC. You get a heads-up about 90 minutes before you need to leave, a 15-minute warning, and "leave now". If you're coming from another event, it plans from there.

- **The brain** is a Google Apps Script: a small program that runs free on Google's servers every 5 minutes. It reads your calendar and asks Google Maps for routes.
- **The app** is a PWA (a website you install like an app), hosted on GitHub Pages. It shows today's plan, holds all your settings, and shows the notifications.
- **Notifications** work like a doorbell: the script sends an empty "ring" through your phone's push service, and the installed app then fetches the message straight from your script. The push service never sees your events.

The full design is in [SPEC.md](SPEC.md).

---

## One-time setup (about 20 minutes on a phone, 10 on a computer)

> **On your phone?** Open script.google.com in Chrome, then tap **⋮ → Desktop site**. This shows the full editor with all its buttons. Pinch to zoom as needed.

### 1. Copy the script into Google

1. Go to https://script.google.com and tap **New project**. Rename it **Leave By**.
2. In GitHub, open [`apps-script/Code.gs`](apps-script/Code.gs) and tap **Raw**, which shows the plain text. Then **Select all → Copy**.
3. In the Apps Script editor, delete the sample code in `Code.gs` and paste yours in.
4. Replace the settings file:
   1. Tap ⚙️ **Project Settings**.
   2. Tick **Show "appsscript.json" manifest file**.
   3. Back in the editor, open `appsscript.json` and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json).
5. Tap 💾 **Save**.

### 2. Start it

1. In the function dropdown at the top, pick **setup**, then tap **Run**.
2. Google asks for permission:
   1. Choose your account.
   2. Tap **Advanced → Go to Leave By (unsafe)**. It says "unsafe" only because it's your own private script.
   3. Tap **Allow**. This lets it read your calendar, use Maps, and send notifications.
3. Tap **Deploy → New deployment**:
   1. Tap the gear and choose **Web app**.
   2. Set **Execute as: Me** and **Who has access: Anyone**.
   3. Tap **Deploy**.
4. Pick **getAppLink** in the dropdown and tap **Run**. The log at the bottom shows a **link** that opens the app already connected.
   - If it warns about a `/dev` link instead, tap **Deploy → Manage deployments** and copy the **Web app URL** (it ends in `/exec`). Open the key-only link it logged, then paste the URL into the app's ⚙︎ → **Connection** and tap **Connect**.

### 3. The app

1. Open the link from step 2.4 in Chrome on your phone.
2. Install it: tap **Install** at the top of the app, or Chrome's **⋮ → Add to Home screen** (or **Install app**).
3. **Open Leave By from its home-screen icon** (notifications only work in the installed app), then tap ⚙︎ **Settings**:
   - enter **Leaving from**: your nearest station or address (it's stored privately in your Google account, not in this public repo)
   - under **This phone**, tap **Enable notifications** and allow them
   - tap **Send test notification**; a test notification should pop up within a few seconds
   - tick any extra calendars you want watched, and tap **Save**
4. Recommended: in Android Settings → Apps → Leave By → Battery, choose **Unrestricted**, so alerts arrive on time.

---

## Everyday use

- **Skip an event** you're not going to: use the **Skip this event** button on the notification, or **Skip** in the app. **Undo** brings it back.
- **Directions:** tap any train or walk option to open it in Google Maps (or Citymapper — choose in ⚙︎ → Your trips).
- **"Can't plan" notification:** the event's location is too vague (e.g. "Brooklyn") or can't be found. Add a street address to the event in Google Calendar, and it will update within 5 minutes.
- **Change settings** (walk time, arrival window, heads-up timing, quiet hours, calendars) in the app's ⚙︎ screen. There's no code to edit.
- **Yellow banner saying checks have stopped:** open the script and run **setup** again.
- **Banner saying the script is out of date:** paste the latest `Code.gs` into script.google.com, save, run **setup** once, then tap **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
- **Banner saying notifications are off:** tap it, then **Enable notifications**.
- **Red "Can't reach your Google script" banner:** tap **How to fix**, or ⚙︎ → Connection → **Check connection**.

## Updating the code

1. Ask Claude Code for the change. It works on a branch and opens a **pull request** (PR), which is a proposed change you can review before it goes live.
2. GitHub runs the tests on the PR automatically. A green ✓ means they passed.
3. The PR description tells you in plain English whether you need to do anything.
4. Merge the PR (in the GitHub app: open the PR → **Merge**). The app updates itself within a few minutes.
5. If `Code.gs` changed, the app will show an "out of date" banner until you:
   1. paste the new version into the Apps Script editor and save;
   2. tap **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The link stays the same.

## Preview

Add `?demo` to the app's address (e.g. `…/train-time/?demo`) to see sample data.

## Tests

`node tests/run.js` runs the backend logic against fake Google services. GitHub runs these tests before every deploy.

## Good to know

- Train times come from Google Maps, which uses MTA schedules. Live MTA delay alerts are added when available.
- It skips events that have no location, are online-only, are all-day, that you declined, that aren't in NYC, and working-location or out-of-office blocks.
- Multi-day events (e.g. a conference running Friday to Sunday) are skipped too, unless you turn on **Include multi-day events** in ⚙︎.

## Privacy

- **This repo is public** (free GitHub Pages needs that), so it contains no personal details. Your home station, calendar content, key and push keys all stay in your Google account.
- **Google access is read-only** for your calendar. The script can't change or delete events.
- **Only your phone can ask the script for your plans.** It needs the app's key, which is stored on your phone. Even with the key, someone would see only today's planned trips, not your whole calendar. **Don't share your one-tap app link.** If it leaks, run **resetSecrets** in the script, then **getAppLink**, open the new link, and tap **Enable notifications** again.
- **Notifications:** the push service only gets an empty "ring". The message text goes straight from your script to your phone. Notifications do show on your lock screen like any app's; to keep event names and places out of them, turn off **Show event names & places** in ⚙︎.
- **Directions:** tapping an option sends the start and end addresses (possibly your home) to Google Maps or Citymapper — only when you tap.
- **Keep the Apps Script project unshared.**
- **Hide your email in commits:** GitHub → Settings → Emails → tick *Keep my email addresses private*.

## Troubleshooting

- **No notifications:**
  1. Check Android Settings → Apps → Leave By → Notifications is allowed.
  2. In script.google.com, pick **checkPush** and tap **Run**. The log should say "✅ Push signing works" and at least 1 device.
  3. In the app, ⚙︎ → Connection → **Check connection**.
  4. Still nothing? ⚙︎ → This phone → **Enable notifications** again.
- **Chrome says Leave By is already installed, but it won't open:** look for it in your app drawer (swipe up) and add it to your home screen. If it won't open, uninstall it in Android Settings → Apps → Leave By, then reinstall from Chrome's ⋮ menu → Add to Home screen.
- **The app says "test link" / "/dev" or "Can't reach your script":** in script.google.com, tap **Deploy → Manage deployments**. Check **Execute as: Me** and **Who has access: Anyone**, then copy the **Web app URL** (it ends in `/exec`). In the app, tap ⚙︎ → **Connection**, paste it into **Apps Script web app URL**, and tap **Connect**.
- **setup fails with a permission error:** Google may need broader access than read-only for your account type. Delete the `"oauthScopes"` block from `appsscript.json`, save, and run **setup** again.
