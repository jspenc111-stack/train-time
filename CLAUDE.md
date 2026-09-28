# CLAUDE.md — Leave By

Personal NYC "when to leave" app. A Google Apps Script backend reads Google Calendar, plans subway trips with Google Maps, and sends ntfy notifications. A static PWA on GitHub Pages shows the plan and edits settings. **SPEC.md is the source of truth for behavior.**

## About the owner

- Not a developer. Explain changes in plain language, and define any technical term the first time you use it.
- Uses an Android phone (Pixel), often from the GitHub mobile app. Keep PR descriptions short and skimmable.

## Layout

- `apps-script/Code.gs`: the whole backend (one file, Apps Script V8). `appsscript.json` is its manifest (permissions, timezone, web app).
- `web/`: the PWA. Plain HTML/CSS/JS with no build step and no dependencies. It is served as-is by `.github/workflows/pages.yml`.
- `tests/run.js`: runs Code.gs in Node's `vm` with fake Google services. No npm packages.
- `tools/make_icons.py`: regenerates `web/icons/*.png` (needs Pillow).

## Commands

- Test: `node tests/run.js` (must print `N passed` with no ✗)
- Preview the app: `cd web && python3 -m http.server 8000`, then open `http://localhost:8000/?demo`

## Rules

1. **This repo is public.** Never commit:
   - personal details (home address or station, names, calendar content),
   - secrets (API key, ntfy topic, the `script.google.com/macros/s/...` web app link),
   - real email addresses.

   Personal settings live in the app's Settings, which are stored in Script Properties. Use made-up examples in demos and tests.
2. **Work on a branch and open a PR.** Never push straight to `main`: pushing to `main` deploys the live app. The PR template's checklist must be filled in.
3. **Tests first.** Add or adjust a test in `tests/run.js` for any behavior change, then run the tests before committing.
4. **Keep SPEC.md in sync.** If behavior changes, update the matching SPEC section in the same PR. Update the README if setup or everyday use changes.
5. **Backend changes need a manual step.** GitHub can't deploy Apps Script. When `apps-script/` changes:
   - bump `VERSION` in `Code.gs` **and** `EXPECTED_BACKEND_VERSION` in `web/app.js` to the same value (a test checks this);
   - start the PR description with: "⚠️ Paste the new Code.gs into script.google.com, then Deploy → Manage deployments → New version."

   The app shows an "out of date" banner until the owner does this.
6. **Web changes:** bump `CACHE` in `web/sw.js` (e.g. `leave-by-v3` → `v4`), so installed apps pick up new files.
7. **Least privilege.** Don't add OAuth scopes to `appsscript.json` or new third-party services without saying why in the PR. The calendar access is read-only on purpose.
8. **Small PRs.** One feature or fix per PR, with a clear title.

## Apps Script gotchas

- Functions ending in `_` are private: they're hidden from the editor's Run menu and can't be called by the web app. Public entry points are `setup`, `getAppLink`, `resetSecrets`, `tick`, `doGet`, `doPost`, `sendTestNotification`, and `logPlans`.
- Script Properties hold ~9 KB per value. The plan store is chunked (`STORE_0..n`), so keep using `loadStore_`/`saveStore_`.
- Everything is global in one file, and code runs in the `America/New_York` timezone.
- Apps Script built-in services have no ES-module imports. Anything the tests touch must be mocked in `makeEnv()` in `tests/run.js`.
- Web app responses redirect through googleusercontent.com. The PWA must use GET, or POST with `Content-Type: text/plain`, to avoid CORS preflight.
