## What changed (plain English)

<!-- 1–3 short sentences a non-developer can follow. -->

## Do I need to do anything?

- [ ] Nothing — merging updates the app automatically
- [ ] ⚠️ Paste the new `apps-script/Code.gs` into script.google.com, then **Deploy → Manage deployments → ✏️ → New version**
- [ ] Change something in the app's ⚙︎ Settings (say what)

## Checklist

- [ ] `node tests/run.js` passes (and new behavior has a test)
- [ ] SPEC.md / README updated if behavior or setup changed
- [ ] If `apps-script/` changed: `VERSION` and `EXPECTED_BACKEND_VERSION` bumped to match
- [ ] If `web/` changed: `CACHE` in `web/sw.js` bumped
- [ ] No personal details or secrets added (addresses, keys, push keys or device addresses, web app link, emails)
